import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  pathToFileURL
} from "node:url";

import {
  Readable
} from "node:stream";

import chromium from "@sparticuz/chromium";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

import {
  unzipSync
} from "fflate";

import puppeteer from "puppeteer-core";

const TEMP_PREFIX =
  "pair-archive-temp/";

const MAX_PACKAGE_BYTES =
  96 * 1024 * 1024;

const MAX_UNPACKED_BYTES =
  300 * 1024 * 1024;

const MAX_ARCHIVE_ENTRIES =
  32;

function sendJson(
  response,
  status,
  body
) {
  response.statusCode =
    status;

  response.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  response.setHeader(
    "Cache-Control",
    "no-store"
  );

  response.end(
    JSON.stringify(
      body
    )
  );
}

function parseBody(
  request
) {
  if (
    typeof request.body ===
    "string"
  ) {
    return JSON.parse(
      request.body
    );
  }

  return (
    request.body ||
    {}
  );
}

function isValidTemporaryKey(
  value
) {
  return (
    typeof value ===
      "string" &&

    value.startsWith(
      TEMP_PREFIX
    ) &&

    value.endsWith(
      ".zip"
    ) &&

    value.length <
      240 &&

    !value.includes(
      ".."
    ) &&

    !value.includes(
      "\\"
    )
  );
}

/*
 * Vercel 환경변수를 복사하는 과정에서 들어갈 수 있는
 * 줄바꿈, 탭, 따옴표, 보이지 않는 문자를 제거합니다.
 */
function cleanEnvironmentValue(
  value
) {
  return String(
    value || ""
  )
    .trim()
    .replace(
      /^["'`]+|["'`]+$/g,
      ""
    )
    .replace(
      /[\r\n\t\u200B-\u200D\uFEFF]/g,
      ""
    )
    .trim();
}

/*
 * R2 환경변수에는 공백이 들어가지 않으므로
 * 남아 있는 모든 공백도 제거합니다.
 */
function compactEnvironmentValue(
  value
) {
  return cleanEnvironmentValue(
    value
  ).replace(
    /\s+/g,
    ""
  );
}

function requiredEnvironment() {
  const values = {
    accountId:
      compactEnvironmentValue(
        process.env
          .R2_ACCOUNT_ID
      ),

    accessKeyId:
      compactEnvironmentValue(
        process.env
          .R2_ACCESS_KEY_ID
      ),

    secretAccessKey:
      compactEnvironmentValue(
        process.env
          .R2_SECRET_ACCESS_KEY
      ),

    bucket:
      compactEnvironmentValue(
        process.env
          .R2_BUCKET_NAME
      )
  };

  const missing =
    Object.entries(
      values
    )
      .filter(
        ([, value]) =>
          !value
      )
      .map(
        ([key]) =>
          key
      );

  if (
    missing.length
  ) {
    throw new Error(
      "누락된 R2 환경변수: " +
      missing.join(", ")
    );
  }

  if (
    !/^[a-zA-Z0-9]+$/.test(
      values.accountId
    )
  ) {
    throw new Error(
      "R2_ACCOUNT_ID에 올바르지 않은 문자가 포함되어 있습니다."
    );
  }

  if (
    !/^[a-zA-Z0-9]+$/.test(
      values.accessKeyId
    )
  ) {
    throw new Error(
      "R2_ACCESS_KEY_ID에 올바르지 않은 문자가 포함되어 있습니다."
    );
  }

  if (
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(
      values.bucket
    )
  ) {
    throw new Error(
      "R2_BUCKET_NAME 형식이 올바르지 않습니다."
    );
  }

  return values;
}

function createClient() {
  const env =
    requiredEnvironment();

  const client =
    new S3Client({
      region:
        "auto",

      endpoint:
        `https://${env.accountId}.r2.cloudflarestorage.com`,

      credentials: {
        accessKeyId:
          env.accessKeyId,

        secretAccessKey:
          env.secretAccessKey
      },

      requestChecksumCalculation:
        "WHEN_REQUIRED",

      responseChecksumValidation:
        "WHEN_REQUIRED"
    });

  return {
    client,
    bucket:
      env.bucket
  };
}

async function bodyToUint8Array(
  body
) {
  if (!body) {
    throw new Error(
      "R2에서 렌더 ZIP을 읽지 못했습니다."
    );
  }

  if (
    typeof body
      .transformToByteArray ===
    "function"
  ) {
    return new Uint8Array(
      await body
        .transformToByteArray()
    );
  }

  const chunks = [];
  let total = 0;

  for await (
    const chunk of body
  ) {
    const buffer =
      Buffer.from(
        chunk
      );

    total +=
      buffer.length;

    if (
      total >
      MAX_PACKAGE_BYTES
    ) {
      throw new Error(
        "렌더 ZIP이 96MB를 넘습니다."
      );
    }

    chunks.push(
      buffer
    );
  }

  return new Uint8Array(
    Buffer.concat(
      chunks
    )
  );
}

function safeEntryPath(
  root,
  name
) {
  if (
    typeof name !==
      "string" ||

    !name ||

    name.includes(
      "\\"
    ) ||

    name.includes(
      "\0"
    )
  ) {
    throw new Error(
      "렌더 ZIP에 올바르지 않은 파일 경로가 있습니다."
    );
  }

  const normalized =
    path.posix.normalize(
      name
    );

  if (
    normalized.startsWith(
      "../"
    ) ||

    normalized ===
      ".." ||

    path.posix.isAbsolute(
      normalized
    )
  ) {
    throw new Error(
      "렌더 ZIP의 파일 경로를 사용할 수 없습니다."
    );
  }

  const destination =
    path.resolve(
      root,
      normalized
    );

  const rootPrefix =
    path.resolve(
      root
    ) +
    path.sep;

  if (
    destination !==
      path.resolve(
        root
      ) &&

    !destination.startsWith(
      rootPrefix
    )
  ) {
    throw new Error(
      "렌더 ZIP의 파일 경로를 사용할 수 없습니다."
    );
  }

  return destination;
}

async function extractPackage(
  zipBytes,
  root
) {
  const files =
    unzipSync(
      zipBytes
    );

  const entries =
    Object.entries(
      files
    );

  if (
    entries.length <
      1 ||

    entries.length >
      MAX_ARCHIVE_ENTRIES
  ) {
    throw new Error(
      "렌더 ZIP의 파일 수가 허용 범위를 벗어났습니다."
    );
  }

  if (
    !files[
      "index.html"
    ]
  ) {
    throw new Error(
      "렌더 ZIP에서 index.html을 찾지 못했습니다."
    );
  }

  let total = 0;

  for (
    const [
      name,
      bytes
    ] of entries
  ) {
    const allowed =
      name ===
        "index.html" ||

      name.startsWith(
        "images/"
      );

    if (!allowed) {
      throw new Error(
        "렌더 ZIP에 허용되지 않은 파일이 포함돼 있습니다."
      );
    }

    total +=
      bytes.byteLength;

    if (
      total >
      MAX_UNPACKED_BYTES
    ) {
      throw new Error(
        "압축을 푼 렌더 자료가 300MB를 넘습니다."
      );
    }

    const destination =
      safeEntryPath(
        root,
        name
      );

    await mkdir(
      path.dirname(
        destination
      ),
      {
        recursive:
          true
      }
    );

    await writeFile(
      destination,
      bytes
    );
  }

  return path.join(
    root,
    "index.html"
  );
}

export default async function handler(
  request,
  response
) {
  if (
    request.method !==
    "POST"
  ) {
    response.setHeader(
      "Allow",
      "POST"
    );

    sendJson(
      response,
      405,
      {
        error:
          "POST 요청만 지원합니다."
      }
    );

    return;
  }

  let body;

  try {
    body =
      parseBody(
        request
      );
  } catch {
    sendJson(
      response,
      400,
      {
        error:
          "렌더링 요청 데이터가 올바른 JSON 형식이 아닙니다."
      }
    );

    return;
  }

  const key =
    body?.key;

  if (
    !isValidTemporaryKey(
      key
    )
  ) {
    sendJson(
      response,
      400,
      {
        error:
          "렌더링할 임시 ZIP 경로가 올바르지 않습니다."
      }
    );

    return;
  }

  const width =
    Math.max(
      900,
      Math.min(
        1800,
        Number(
          body?.width
        ) || 1440
      )
    );

  const scale =
    Math.max(
      1,
      Math.min(
        3,
        Number(
          body?.scale
        ) || 2
      )
    );

  let browser;
  let tempDirectory =
    "";

  let client =
    null;

  let bucket =
    "";

  try {
    ({
      client,
      bucket
    } = createClient());

    const object =
      await client.send(
        new GetObjectCommand({
          Bucket:
            bucket,

          Key:
            key
        })
      );

    if (
      Number(
        object.ContentLength ||
        0
      ) >
      MAX_PACKAGE_BYTES
    ) {
      throw new Error(
        "렌더 ZIP이 96MB를 넘습니다."
      );
    }

    const zipBytes =
      await bodyToUint8Array(
        object.Body
      );

    if (
      zipBytes.byteLength >
      MAX_PACKAGE_BYTES
    ) {
      throw new Error(
        "렌더 ZIP이 96MB를 넘습니다."
      );
    }

    tempDirectory =
      await mkdtemp(
        path.join(
          os.tmpdir(),
          "pair-archive-"
        )
      );

    const indexPath =
      await extractPackage(
        zipBytes,
        tempDirectory
      );

    browser =
      await puppeteer.launch({
        args: [
          ...chromium.args,
          "--allow-file-access-from-files"
        ],

        defaultViewport: {
          width,
          height:
            1200,

          deviceScaleFactor:
            scale
        },

        executablePath:
          await chromium
            .executablePath(),

        headless:
          chromium.headless
      });

    const page =
      await browser
        .newPage();

    await page
      .setExtraHTTPHeaders({
        "Accept-Language":
          "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
      });

    await page
      .setViewport({
        width,
        height:
          1200,

        deviceScaleFactor:
          scale
      });

    await page.goto(
      pathToFileURL(
        indexPath
      ).href,
      {
        waitUntil: [
          "domcontentloaded",
          "networkidle0"
        ],

        timeout:
          60_000
      }
    );

    await page.evaluate(
      async () => {
        if (
          document.fonts
        ) {
          await Promise
            .allSettled([
              document.fonts.load(
                '400 16px "Noto Sans KR"',
                "한글 漢字"
              ),

              document.fonts.load(
                '700 16px "Noto Sans KR"',
                "한글 漢字"
              ),

              document.fonts.load(
                '900 16px "Noto Sans KR"',
                "한글 漢字"
              )
            ]);

          await document
            .fonts
            .ready;
        }

        await Promise.all(
          Array.from(
            document.images
          ).map(
            async (
              image
            ) => {
              try {
                if (
                  typeof image
                    .decode ===
                  "function"
                ) {
                  await image
                    .decode();
                }
              } catch {
                // 깨진 이미지가 있어도 나머지는 렌더링합니다.
              }
            }
          )
        );

        await new Promise(
          (
            resolve
          ) => {
            requestAnimationFrame(
              () => {
                requestAnimationFrame(
                  resolve
                );
              }
            );
          }
        );
      }
    );

    const captureExists =
      await page.$(
        "#captureArea"
      );

    if (!captureExists) {
      throw new Error(
        "저장 영역을 찾지 못했습니다."
      );
    }

    const dimensions =
      await page.$eval(
        "#captureArea",
        (
          element
        ) => ({
          width:
            Math.ceil(
              element
                .getBoundingClientRect()
                .width
            ),

          height:
            Math.ceil(
              element
                .scrollHeight
            )
        })
      );

    if (
      !Number.isFinite(
        dimensions.width
      ) ||

      !Number.isFinite(
        dimensions.height
      ) ||

      dimensions.width <=
        0 ||

      dimensions.height <=
        0
    ) {
      throw new Error(
        "저장 영역의 크기를 계산하지 못했습니다."
      );
    }

    await page
      .setViewport({
        width:
          Math.max(
            900,
            Math.min(
              1800,
              dimensions.width
            )
          ),

        height:
          Math.max(
            900,
            Math.min(
              8000,
              dimensions.height
            )
          ),

        deviceScaleFactor:
          scale
      });

    await page.evaluate(
      () =>
        new Promise(
          (
            resolve
          ) => {
            requestAnimationFrame(
              () => {
                requestAnimationFrame(
                  resolve
                );
              }
            );
          }
        )
    );

    const target =
      await page.$(
        "#captureArea"
      );

    if (!target) {
      throw new Error(
        "저장 영역을 찾지 못했습니다."
      );
    }

    const png =
      await target
        .screenshot({
          type:
            "png",

          omitBackground:
            false,

          captureBeyondViewport:
            true
        });

    response.statusCode =
      200;

    response.setHeader(
      "Content-Type",
      "image/png"
    );

    response.setHeader(
      "Content-Disposition",
      'inline; filename="pair-archive.png"'
    );

    response.setHeader(
      "Cache-Control",
      "no-store"
    );

    Readable
      .from(
        png
      )
      .pipe(
        response
      );
  } catch (
    error
  ) {
    console.error(
      "Chromium render API error:",
      error
    );

    if (
      !response.headersSent
    ) {
      sendJson(
        response,
        500,
        {
          error:
            error?.message ||
            "Chromium 렌더링 중 오류가 발생했습니다."
        }
      );
    } else {
      response.end();
    }
  } finally {
    try {
      await browser
        ?.close();
    } catch (
      error
    ) {
      console.warn(
        "Chromium 브라우저를 종료하지 못했습니다.",
        error
      );
    }

    if (
      tempDirectory
    ) {
      try {
        await rm(
          tempDirectory,
          {
            recursive:
              true,

            force:
              true
          }
        );
      } catch (
        error
      ) {
        console.warn(
          "임시 압축 해제 폴더를 정리하지 못했습니다.",
          error
        );
      }
    }

    if (
      client &&
      bucket
    ) {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket:
              bucket,

            Key:
              key
          })
        );
      } catch (
        error
      ) {
        console.warn(
          "R2 임시 ZIP 삭제에 실패했습니다.",
          error
        );
      }
    }
  }
}
