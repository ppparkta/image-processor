import sharp from "sharp";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";

import { IMAGE_TYPE_POLICY } from "./policy/imageTypePolicy.js";
import { VARIANTS } from "./policy/imageVariant.js";

const s3 = new S3Client({});
const BUCKET = "techcourse-project-2025";
const ROOT_PREFIX = "fit-toring";
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

export const handler = async (event) => {
  const record = event.records?.[0] || event.Records?.[0];
  if (!record) return ok("no record");

  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
  console.log("Event Key:", key);

  if (key.toLowerCase().endsWith(".avif")) return ok("skip: avif");

  const parts = key.split("/");
  if (parts.length < 4) return err("key pattern mismatch");

  const [root, imageType, folder, ...rest] = parts;
  if (root !== ROOT_PREFIX || folder !== VARIANTS.DEFAULT.name) {
    return ok("skip: not under fit-toring/{type}/default/");
  }

  const filename = rest.join("/");
  const extIdx = filename.lastIndexOf(".");
  if (extIdx < 0) return err("no extension");

  const basename = filename.slice(0, extIdx);

  // 원본 확장자(대소문자 보존)와 소문자 확장자 둘 다 보관
  const extRaw = filename.slice(extIdx);           // 예: ".JPG"
  const extLower = extRaw.toLowerCase();          // 예: ".jpg"
  if (!ALLOWED_EXTENSIONS.includes(extLower)) {
    return ok(`skip: unsupported ext ${extRaw}`);
  }
  const hasUpperInExt = /[A-Z]/.test(extRaw);

  // 재귀 방지(head에 processed 메타데이터로 멱등/재귀 방지)
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    const processed = head.Metadata && head.Metadata.processed === "true";
    if (processed) return ok("skip: already processed default object");
  } catch (e) {
    console.log("headObject failed (continue):", e?.name, e?.message);
  }

  const variants = IMAGE_TYPE_POLICY[imageType] || IMAGE_TYPE_POLICY._default;
  console.log("variants:", variants.map(v => `${v.name}:${v.maxWidth}`).join(", "));

  let srcBuffer;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    srcBuffer = Buffer.from(await obj.Body.transformToByteArray());
  } catch (e) {
    return err(`getObject failed: ${e.message}`);
  }

  try {
    const tasks = [];
    for (const variant of variants) {
      const outDir = `${ROOT_PREFIX}/${imageType}/${variant.name}`;

      // default 변환 산출물만 원본 확장자 케이스 유지
      const extForVariant = (variant.name === VARIANTS.DEFAULT.name && hasUpperInExt)
        ? extRaw
        : extLower;

      const dstKeyExt = `${outDir}/${basename}${extForVariant}`;
      const dstKeyAvif = `${outDir}/${basename}.avif`;

      const resized = await resizeToMaxWidth(srcBuffer, variant.maxWidth, {
        // 코덱 선택은 소문자 기준으로
        targetExt: extLower,
        transparentToWhite: true,
        rotate: true,
      });

      // default 키에는 processed=true 메타데이터로 재귀/멱등 방지
      const meta = (variant.name === VARIANTS.DEFAULT.name) ? { processed: "true" } : undefined;

      tasks.push(putObject(dstKeyExt, resized, contentTypeOf(extLower), meta));

      const avif = await toAvif(resized);
      tasks.push(putObject(dstKeyAvif, avif, "image/avif"));
    }

    await Promise.all(tasks);
    return ok(`done: ${filename}`);
  } catch (e) {
    console.error(e);
    return err(e.message || String(e));
  }
};

function contentTypeOf(ext) {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function resizeToMaxWidth(inputBuffer, maxWidth, opts = {}) {
  const { targetExt = ".jpg", rotate = true, transparentToWhite = true } = opts;
  let pipeline = sharp(inputBuffer, { failOn: "none" });
  if (rotate) pipeline = pipeline.rotate();

  const meta = await pipeline.metadata();
  const width = meta.width || maxWidth;
  if (width > maxWidth) pipeline = pipeline.resize({ width: maxWidth });
  if (transparentToWhite) pipeline = pipeline.flatten({ background: "#fff" });

  switch ((targetExt || ".jpg").toLowerCase()) {
    case ".png":
      pipeline = pipeline.png({ compressionLevel: 9 });
      break;
    case ".webp":
      pipeline = pipeline.webp({ quality: 70, effort: 4 });
      break;
    case ".jpg":
    case ".jpeg":
      pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
      break;
    default:
      pipeline = pipeline.jpeg({ quality: 85 });
      break;
  }
  return pipeline.toBuffer();
}

async function toAvif(buffer) {
  return sharp(buffer, { failOn: "none" })
    .avif({ quality: 55, effort: 4 })
    .toBuffer();
}

async function putObject(Key, Body, ContentType, Metadata) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key,
    Body,
    ContentType,
    Metadata
  }));
}

function ok(msg) {
  console.log("[OK]", msg);
  return { statusCode: 200, body: msg };
}
function err(msg) {
  console.error("[ERR]", msg);
  return { statusCode: 500, body: msg };
}
