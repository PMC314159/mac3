import crypto from "node:crypto";

import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

import {
  getSignedUrl
} from "@aws-sdk/s3-request-presigner";

const MAX_PACKAGE_BYTES =
  96 * 1024 * 1024;

const TEMP_PREFIX =
  "pair-archive-temp/";

function sendJson(
  response,
  status,
  body
) {
  response.statusCode = status;

  response.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  response.setHeader(
    "Cache-Control",
    "no-store"
  );

  response.end(
    JSON.stringify(body)
  );
}

function parseBody(request) {
  if (
    typeof request.body ===
    "string"
  ) {
    return JSON.parse(
      request.body
    );
  }

  return request.body || {};
}

/*
 * Vercel 환경변수를 복사하는 과정에서 들어갈 수 있는
 * 줄바꿈, 탭, 따옴표, 보이지 않는 문자를 제거합니다.
 */
function cleanEnvironmentValue(value) {
  return String(value || "")
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
 * Account ID, Access Key, Secret Key, 버킷 이름에는
 * 공백이 들어가지 않으므로 남아 있는 모든 공백을 제거합니다.
 */
function compactEnvironmentValue(value) {
  return cleanEnvironmentValue(
    value
  ).replace(/\s+/g, "");
}

function requiredEnvironment() {
  const values = {
    accountId:
      compactEnvironmentValue(
        process.env.R2_ACCOUNT_ID
      ),

    accessKeyId:
      compactEnvironmentValue(
        process.env.R2_ACCESS_KEY_ID
      ),

    secretAccessKey:
      compactEnvironmentValue(
        process.env.R2_SECRET_ACCESS_KEY
      ),

    bucket:
      compactEnvironmentValue(
        process.env.R2_BUCKET_NAME
      )
  };

  const missing =
    Object.entries(values)
      .filter(([, value]) =>
        !value
      )
      .map(([key]) => key);

  if (missing.length) {
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
      region: "auto",

      endpoint:
        `https://${env.accountId}.r2.cloudflarestorage.com`,

      credentials: {
        accessKeyId:
          env.accessKeyId,

        secretAccessKey:
          env.secretAccessKey
      },

      /*
       * Presigned PUT URL에 빈 파일용 CRC32 체크섬이
       * 붙으면서 R2 서명이 어긋나는 문제를 방지합니다.
       */
      requestChecksumCalculation:
        "WHEN_REQUIRED",

      responseChecksumValidation:
        "WHEN_REQUIRED"
    });

  return {
    client,
    bucket: env.bucket
  };
}

function isValidTemporaryKey(value) {
  return (
    typeof value === "string" &&

    value.startsWith(
      TEMP_PREFIX
    ) &&

    value.endsWith(
      ".zip"
    ) &&

    value.length < 240 &&

    !value.includes(
      ".."
    ) &&

    !value.includes(
      "\\"
    )
  );
}

function enforceSameOrigin(request) {
  const origin =
    request.headers.origin;

  if (!origin) {
    return;
  }

  const forwardedHost =
    request.headers[
      "x-forwarded-host"
    ];

  const host =
    String(
      forwardedHost ||
      request.headers.host ||
      ""
    )
      .split(",")[0]
      .trim();

  let originHost = "";

  try {
    originHost =
      new URL(origin).host;
  } catch {
    throw new Error(
      "허용되지 않은 요청 출처입니다."
    );
  }

  if (
    !host ||
    originHost !== host
  ) {
    throw new Error(
      "현재 사이트에서 시작된 요청만 허용됩니다."
    );
  }
}

export default async function handler(
  request,
  response
) {
  if (
    request.method !== "POST" &&
    request.method !== "DELETE"
  ) {
    response.setHeader(
      "Allow",
      "POST, DELETE"
    );

    sendJson(
      response,
      405,
      {
        error:
          "POST 또는 DELETE 요청만 지원합니다."
      }
    );

    return;
  }

  try {
    enforceSameOrigin(
      request
    );

    const body =
      parseBody(
        request
      );

    const {
      client,
      bucket
    } = createClient();

    /*
     * 사용을 마친 임시 ZIP 파일 삭제
     */
    if (
      request.method ===
      "DELETE"
    ) {
      const key =
        body?.key;

      if (
        !isValidTemporaryKey(
          key
        )
      ) {
        throw new Error(
          "삭제할 임시 패키지 경로가 올바르지 않습니다."
        );
      }

      await client.send(
        new DeleteObjectCommand({
          Bucket:
            bucket,

          Key:
            key
        })
      );

      sendJson(
        response,
        200,
        {
          deleted: true
        }
      );

      return;
    }

    /*
     * R2에 올릴 ZIP 크기 검사
     */
    const size =
      Number(
        body?.size
      );

    if (
      !Number.isFinite(
        size
      ) ||

      size <= 0 ||

      size >
        MAX_PACKAGE_BYTES
    ) {
      throw new Error(
        "렌더 ZIP은 96MB 이하여야 합니다."
      );
    }

    /*
     * 임시 ZIP 객체 경로 생성
     */
    const key =
      TEMP_PREFIX +
      Date.now() +
      "-" +
      crypto.randomUUID() +
      ".zip";

    /*
     * 브라우저에서 R2로 직접 PUT할 수 있는
     * 5분 유효 Presigned URL 생성
     */
    const uploadUrl =
      await getSignedUrl(
        client,

        new PutObjectCommand({
          Bucket:
            bucket,

          Key:
            key,

          ContentType:
            "application/zip"
        }),

        {
          expiresIn: 300
        }
      );

    sendJson(
      response,
      200,
      {
        key,

        uploadUrl,

        expiresIn:
          300,

        maximumSizeInBytes:
          MAX_PACKAGE_BYTES
      }
    );
  } catch (error) {
    console.error(
      "R2 upload API error:",
      error
    );

    sendJson(
      response,
      400,
      {
        error:
          error?.message ||
          "R2 업로드 요청을 준비하지 못했습니다."
      }
    );
  }
}
