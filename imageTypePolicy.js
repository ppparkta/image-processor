const { VARIANTS } = require("./imageVariant");
const { IMAGE_TYPE } = require("./imageType");

const IMAGE_TYPE_POLICY = {
    [IMAGE_TYPE.MENTORING_PROFILE]: [VARIANTS.DEFAULT, VARIANTS.THUMB_MEDIUM],
    [IMAGE_TYPE.CERTIFICATE]:       [VARIANTS.DEFAULT],
    [IMAGE_TYPE.NONE]:              [VARIANTS.DEFAULT],
    _default:                       [VARIANTS.DEFAULT],
  };
  
  module.exports = { IMAGE_TYPE_POLICY };
