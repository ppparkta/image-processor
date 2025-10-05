import sharp from "sharp";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { IMAGE_TYPE_POLICY } from "./policy/imageTypePolicy.js";
import { VARIANTS } from "./policy/imageVariant.js";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const BUCKET = "techcourse-project-2025";
const ROOT_PREFIX = "fit-toring";
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

const QUEUE_URL = "https://sqs.ap-northeast-2.amazonaws.com/843255971531/fittoring-image-queue";

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

  const extRaw = filename.slice(extIdx);      // 예: ".JPG"
  const extLower = extRaw.toLowerCase();      // 예: ".jpg"
  if (!ALLOWED_EXTENSIONS.includes(extLower)) {
    return ok(`skip: unsupported ext ${extRaw}`);
  }
  const hasUpperInExt = /[A-Z]/.test(extRaw);

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
    // variant 단위로 업로드 → SQS 발행을 순차 보장
    await Promise.all(variants.map(v => produceOneVariant({
      variant: v,
      imageType,
      basename,
      extLower,
      extRaw,
      hasUpperInExt,
      srcBuffer,
    })));

    return ok(`done: ${filename}`);
  } catch (e) {
    console.error(e);
    return err(e.message || String(e));
  }
};

async function produceOneVariant({
  variant,
  imageType,
  basename,
  extLower,
  extRaw,
  hasUpperInExt,
  srcBuffer,
}) {
  const outDir = `${ROOT_PREFIX}/${imageType}/${variant.name}`;

  const extForVariant = (variant.name === VARIANTS.DEFAULT.name && hasUpperInExt)
    ? extRaw
    : extLower;

  const dstKeyExt  = `${outDir}/${basename}${extForVariant}`;
  const dstKeyAvif = `${outDir}/${basename}.avif`;

  const resized = await resizeToMaxWidth(srcBuffer, variant.maxWidth, {
    targetExt: extLower,
    transparentToWhite: true,
    rotate: true,
  });

  const meta = (variant.name === VARIANTS.DEFAULT.name) ? { processed: "true" } : undefined;

  // 업로드 (원본확장자)
  await putObject(dstKeyExt, resized, contentTypeOf(extLower), meta);
  await sendSqsMessage({
    event: "IMAGE_DERIVATIVE_READY",
    imageType,
    baseName: basename,
    imageVariant: variant.name,
    url: toS3Url(dstKeyExt),
  });

  // 업로드 (AVIF)
  const avif = await toAvif(resized);
  await putObject(dstKeyAvif, avif, "image/avif");
}

function toS3Url(key) {
  const region = process.env.AWS_REGION || "ap-northeast-2";
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://${BUCKET}.s3.${region}.amazonaws.com/${encodedKey}`;
}

async function sendSqsMessage(payload) {
  if (!QUEUE_URL) {
    console.warn("[SQS] DERIVATIVE_QUEUE_URL is not set. Skip sending.", payload);
    return;
  }
  await sqs.send(new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify(payload),
    // FIFO 큐 전환 시 아래 두 줄을 추가
    // MessageGroupId: payload.baseName,
    // MessageDeduplicationId: `${payload.baseName}:${payload.imageVariant}:${payload.url}`,
  }));
}

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
