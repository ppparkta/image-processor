import { IMAGE_TYPE } from "./imageType.js";
import { VARIANTS } from "./imageVariant.js";

export const IMAGE_TYPE_POLICY = {
  [IMAGE_TYPE.MENTORING_PROFILE]: [
    VARIANTS.DEFAULT, VARIANTS.THUMBNAIL_MEDIUM
  ],
  [IMAGE_TYPE.CERTIFICATE]: [
    VARIANTS.DEFAULT
  ],
  _default: [
    VARIANTS.DEFAULT
  ]
};
