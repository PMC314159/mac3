import { Readable } from "node:stream";
import chromium from "@sparticuz/chromium";
import { del } from "@vercel/blob";
import puppeteer from "puppeteer-core";

const MAX_HTML_LENGTH = 4_250_000;

function isTemporaryBlobUrl(value) {
  try {
    const url = new URL(value);

    const validHost =
      url.hostname ===
        "public.blob.vercel-storage.com" ||
      url.hostname.endsWith(
        ".public.blob.vercel-storage.com"
      );

    return (
      url.protocol === "https:" &&
      validHost &&
      url.pathname.includes(
        "/pair-archive-temp/"
      )
    );
  } catch {
    return false;
  }
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, {
      error: "POST 요청만 지원합니다."
    });
    return;
  }

  const body =
    typeof request.body === "string"
      ? JSON.parse(request.body)
      : request.body;

  const html = body?.html;

  const temporaryBlobUrls =
    Array.from(
      new Set(
        (
          Array.isArray(
            body?.temporaryBlobUrls
          )
            ? body.temporaryBlobUrls
            : []
        ).filter(
          isTemporaryBlobUrl
        )
      )
    );

  const width = Math.max(
    900,
    Math.min(1800, Number(body?.width) || 1440)
  );
  const scale = Math.max(
    1,
    Math.min(3, Number(body?.scale) || 2)
  );

  if (typeof html !== "string" || !html.includes('id="captureArea"')) {
    sendJson(response, 400, {
      error: "렌더링할 HTML을 확인하지 못했습니다."
    });
    return;
  }

  if (html.length > MAX_HTML_LENGTH) {
    sendJson(response, 413, {
      error:
        "첨부 이미지 용량이 너무 큽니다. " +
        "이미지를 줄여 다시 업로드해 주세요."
    });
    return;
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: {
        width,
        height: 1200,
        deviceScaleFactor: scale
      },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      "Accept-Language":
        "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
    });

    await page.setViewport({
      width,
      height: 1200,
      deviceScaleFactor: scale
    });

    await page.setContent(html, {
      waitUntil: ["domcontentloaded", "networkidle0"],
      timeout: 45_000
    });

    await page.evaluate(async () => {
      if (document.fonts) {
        await Promise.allSettled([
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

        await document.fonts.ready;
      }

      await Promise.all(
        Array.from(document.images).map(async (image) => {
          try {
            if (typeof image.decode === "function") {
              await image.decode();
            }
          } catch (error) {
            // 깨진 선택 이미지가 있더라도 나머지는 렌더링합니다.
          }
        })
      );

      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });
    });

    const dimensions = await page.$eval(
      "#captureArea",
      (element) => ({
        width: Math.ceil(element.getBoundingClientRect().width),
        height: Math.ceil(element.scrollHeight)
      })
    );

    await page.setViewport({
      width: dimensions.width,
      height: Math.max(900, Math.min(8000, dimensions.height)),
      deviceScaleFactor: scale
    });

    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
          });
        })
    );

    const target = await page.$("#captureArea");

    if (!target) {
      throw new Error("저장 영역을 찾지 못했습니다.");
    }

    const png = await target.screenshot({
      type: "png",
      omitBackground: false,
      captureBeyondViewport: true
    });

    response.statusCode = 200;
    response.setHeader("Content-Type", "image/png");
    response.setHeader(
      "Content-Disposition",
      'inline; filename="pair-archive.png"'
    );
    response.setHeader("Cache-Control", "no-store");

    /*
     * Vercel 함수의 일반 응답 본문 제한을 피하기 위해
     * PNG Buffer를 스트림으로 전송합니다.
     */
    Readable.from(png).pipe(response);
  } catch (error) {
    console.error(error);

    if (!response.headersSent) {
      sendJson(response, 500, {
        error:
          "Chromium 렌더링 중 오류가 발생했습니다. " +
          "Vercel 배포 로그를 확인해 주세요."
      });
    } else {
      response.end();
    }
  } finally {
    await browser?.close();

    if (temporaryBlobUrls.length) {
      try {
        await del(
          temporaryBlobUrls
        );
      } catch (error) {
        console.warn(
          "임시 Blob 정리에 실패했습니다.",
          error
        );
      }
    }
  }
}
