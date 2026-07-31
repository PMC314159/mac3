import {
  handleUpload
} from "@vercel/blob/client";
import {
  del
} from "@vercel/blob";

const MAX_IMAGE_SIZE =
  60 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif"
];

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
    return JSON.parse(request.body);
  }

  return request.body || {};
}

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

    sendJson(response, 405, {
      error:
        "POST 또는 DELETE 요청만 지원합니다."
    });
    return;
  }

  try {
    if (
      request.method === "DELETE"
    ) {
      const body =
        parseBody(request);

      const urls = Array.from(
        new Set(
          (Array.isArray(body?.urls)
            ? body.urls
            : []
          ).filter(
            isTemporaryBlobUrl
          )
        )
      );

      if (urls.length) {
        await del(urls);
      }

      sendJson(response, 200, {
        deleted: urls.length
      });
      return;
    }

    const body =
      parseBody(request);

    const jsonResponse =
      await handleUpload({
        body,
        request,

        onBeforeGenerateToken:
          async (pathname) => {
            if (
              typeof pathname !==
                "string" ||
              !pathname.startsWith(
                "pair-archive-temp/"
              )
            ) {
              throw new Error(
                "허용되지 않은 업로드 경로입니다."
              );
            }

            return {
              allowedContentTypes:
                ALLOWED_CONTENT_TYPES,
              maximumSizeInBytes:
                MAX_IMAGE_SIZE,
              addRandomSuffix: true,
              tokenPayload:
                JSON.stringify({
                  createdAt:
                    Date.now()
                })
            };
          },

        onUploadCompleted:
          async ({ blob }) => {
            console.log(
              "Temporary pair archive image uploaded:",
              blob.pathname
            );
          }
      });

    sendJson(
      response,
      200,
      jsonResponse
    );
  } catch (error) {
    console.error(error);

    sendJson(response, 400, {
      error:
        error?.message ||
        "이미지 업로드 토큰을 생성하지 못했습니다."
    });
  }
}
