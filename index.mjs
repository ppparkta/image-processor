const sharp = require("sharp");
const AWS = require("aws-sdk");
const s3 = new AWS.S3();

const BUCKET = process.env.BUCKET || "techcourse-project-2025";

const POLICY = {
  "mentoring-profile": { defaultMaxWidth: 500, thumbWidth: 300 },
  "certificate-image": { defaultMaxWidth: 500, thumbWidth: 300 },

  "_default": { defaultMaxWidth: 1600, thumbWidth: 360 },
};

const ALLOWED_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

exports.handler = async (event) => {
  const record = event.Records?.[0];
  if (!record) return ok("no record");

  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
  console.log("Event Key:", key);

  // 2) 스킵 조건: thumbnail 경로, avif 파일
  if (key.includes("/thumbnail/") || key.toLowerCase().endsWith(".avif")) {
    return ok("skip: thumbnail or avif");
  }

  // 3) 경로 파싱: fit-toring/{imageType}/default/filename.ext
  const parts = key.split("/");
  if (parts.length < 4) return err("key pattern mismatch");

  const [root, imageType, folder, ...rest] = parts;
  if (root !== "fit-toring" || folder !== "default") {
    return ok("skip: not under fit-toring/{type}/default/");
  }
  const filename = rest.join("/")
  const extIdx = filename.lastIndexOf(".");
  if (extIdx < 0) return err("no extension");

  const basename = filename.slice(0, extIdx);
  const ext = filename.slice(extIdx).toLowerCase();

  if (!ALLOWED_EXTS.includes(ext)) {
    return ok(`skip: unsupported ext ${ext}`);
  }

  // 4) 재귀 방지(2): 이미 처리된 default 파일인지 확인(메타데이터)
  // default 파일을 덮어쓰면 또 이벤트가 생기므로, processed:true인 경우 skip
  try {
    const head = await s3.headObject({ Bucket: BUCKET, Key: key }).promise();
    // 업로드 직후 이벤트에서는 이전 메타데이터가 없을 수 있으니 Optional
    const processed = (head.Metadata && head.Metadata.processed === "true") ? true : false;
    if (processed) {
      return ok("skip: already processed default object");
    }
  } catch (e) {
    // 없는 키면 아래에서 getObject에서 실패로 잡힘
    console.log("headObject failed (will continue):", e?.message);
  }

  // 5) 정책 로드
  const policy = POLICY[imageType] || POLICY["_default"];
  const { defaultMaxWidth, thumbWidth } = policy;
  console.log("policy:", policy);

  // 6) 원본 로딩
  let obj;
  try {
    obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
  } catch (e) {
    return err(`getObject failed: ${e.message}`);
  }
  let buffer = obj.Body;

  // 7) HEIC/HEIF → JPEG 변환(레이어/빌드가 HEIC 지원되면 sharp만으로도 가능)
  const isHeic = ext === ".heic" || ext === ".heif";
  if (isHeic) {
    try {
      console.log("Converting HEIC/HEIF -> JPEG");
      buffer = await heicConvert({
        buffer,
        format: "JPEG",
        quality: 1, // 0-1
      });
    } catch (e) {
      return err(`heic convert failed: ${e.message}`);
    }
  }

  // 8) 리사이즈 파이프라인
  try {
    // default 리사이즈 결과 (원본 확장자 유지)
    const defaultResized = await resizeToMaxWidth(buffer, defaultMaxWidth, {
      targetExt: ext,               // 원본 확장자 유지
      transparentToWhite: true,     // PNG 투명 → 흰배경 flatten
      rotate: true,
    });

    // default AVIF
    const defaultAvif = await toAvif(defaultResized);

    // thumbnail(원본 버퍼 기준으로 downscale)
    const thumbResized = await resizeToMaxWidth(buffer, thumbWidth, {
      targetExt: ext,
      transparentToWhite: true,
      rotate: true,
    });

    // thumbnail AVIF
    const thumbAvif = await toAvif(thumbResized);

    // 9) 업로드 경로
    const defaultKey = `fit-toring/${imageType}/default/${basename}${ext}`;
    const defaultAvifKey = `fit-toring/${imageType}/default/${basename}.avif`;
    const thumbKey = `fit-toring/${imageType}/thumbnail/${basename}${ext}`;
    const thumbAvifKey = `fit-toring/${imageType}/thumbnail/${basename}.avif`;

    // 10) 업로드(멱등/재귀 방지를 위해 default에 processed=true 메타데이터 세팅)
    await Promise.all([
      putObject(defaultKey, defaultResized, contentTypeOf(ext), { processed: "true" }),
      putObject(defaultAvifKey, defaultAvif, "image/avif"),
      putObject(thumbKey, thumbResized, contentTypeOf(ext)),
      putObject(thumbAvifKey, thumbAvif, "image/avif"),
    ]);

    return ok(`done: ${filename}`);
  } catch (e) {
    return err(e.message || String(e));
  }
};

// --- helpers ---

function contentTypeOf(ext) {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
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

  // 메타에서 원본 폭 체크 후 필요할 때만 축소
  const meta = await pipeline.metadata();
  const width = meta.width || maxWidth;
  if (width > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth });
  }

  if (transparentToWhite) {
    pipeline = pipeline.flatten({ background: "#fff" }); // 알파 제거
  }

  const ext = targetExt.toLowerCase();
  switch (ext) {
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
    case ".gif":
      // gif는 정적 프레임으로 처리됨(애니메이션 gif 보존 X)
      pipeline = pipeline.gif();
      break;
    case ".tif":
    case ".tiff":
      pipeline = pipeline.tiff({ quality: 85, compression: "jpeg" });
      break;
    default:
      // 모르는 확장자는 JPEG로
      pipeline = pipeline.jpeg({ quality: 85 });
      break;
  }

  return pipeline.toBuffer();
}

async function toAvif(buffer) {
  return sharp(buffer, { failOn: "none" })
    .avif({ quality: 55, effort: 4 }) // 용량/품질 균형
    .toBuffer();
}

async function putObject(Key, Body, ContentType, Metadata) {
  await s3
    .putObject({
      Bucket: BUCKET,
      Key,
      Body,
      ContentType,
      Metadata, // default 키에는 { processed: "true" } 넣어 재귀 방지
      // Tagging: "Project=FitToring&Role=Image", // 필요하면 태그도
    })
    .promise();
}

function ok(msg) {
  console.log("[OK]", msg);
  return { statusCode: 200, body: msg };
}
function err(msg) {
  console.error("[ERR]", msg);
  return { statusCode: 500, body: msg };
}
