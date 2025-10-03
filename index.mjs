const sharp = require("sharp");
const AWS = require("aws-sdk");
const s3 = new AWS.S3();

const { IMAGE_TYPE_POLICY } = require("./imageTypePolicy");
const { VARIANTS } = require("./imageVariant"); 

const BUCKET = "techcourse-project-2025";
const ROOT_PREFIX = "fit-toring";
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

exports.handler = async (event) => {
  const record = event.records?.[0] || event.Records?.[0];
  if (!record) return ok("no record");

  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
  console.log("Event Key:", key);

  if (key.toLowerCase().endsWith(".avif")) {
    return ok("skip: avif");
  }

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
  const ext = filename.slice(extIdx).toLowerCase();

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return ok(`skip: unsupported ext ${ext}`);
  }

  // 재귀 방지
  try {
    const head = await s3.headObject({ Bucket: BUCKET, Key: key }).promise();
    const processed = head.Metadata && head.Metadata.processed === "true";
    if (processed) return ok("skip: already processed default object");
  } catch (e) {
    console.log("headObject failed (continue):", e?.message);
  }

  const variants = IMAGE_TYPE_POLICY[imageType] || IMAGE_TYPE_POLICY._default;
  console.log("variants:", variants.map(v => `${v.name}:${v.maxWidth}`).join(", "));

  let obj;
  try {
    obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
  } catch (e) {
    return err(`getObject failed: ${e.message}`);
  }
  const srcBuffer = obj.Body;

  try {
    const tasks = [];
    for (const variant of variants) {
      const outDir = `${ROOT_PREFIX}/${imageType}/${variant.name}`;
      const dstKeyExt = `${outDir}/${basename}${ext}`;
      const dstKeyAvif = `${outDir}/${basename}.avif`;

      const resized = await resizeToMaxWidth(srcBuffer, variant.maxWidth, {
        targetExt: ext,
        transparentToWhite: true,
        rotate: true,
      });
      const avif = await toAvif(resized);

      const meta = (variant.name === VARIANTS.DEFAULT.name) ? { processed: "true" } : undefined;

      tasks.push(putObject(dstKeyExt, resized, contentTypeOf(ext), meta));
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
  await s3.putObject({ Bucket: BUCKET, Key, Body, ContentType, Metadata }).promise();
}

function ok(msg) {
  console.log("[OK]", msg);
  return { statusCode: 200, body: msg };
}
function err(msg) {
  console.error("[ERR]", msg);
  return { statusCode: 500, body: msg };
}
