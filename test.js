const axios = require("axios");
const FormData = require("form-data");
let data = new FormData();
data.append("appid", "gov-subsidy-h5");
data.append("channelId", "2025_18_1482_HUNAN");
data.append("functionId", "bindingQualification");
data.append("loginType", "null");
data.append(
  "body",
  '{"provinceId":18,"cateId":"B01","cateName":"手机","clientVersion":"13.0.0","locProvinceId":18,"loCityId":1482,"otherPos":"{\\"code\\":0,\\"message\\":\\"ok\\",\\"region\\":\\"中国\\",\\"regionid\\":\\"0\\",\\"province\\":\\"湖南\\",\\"provinceid\\":\\"18\\",\\"city\\":\\"长沙市\\",\\"cityid\\":\\"1482\\",\\"district\\":\\"岳麓区\\",\\"districtid\\":\\"48936\\",\\"town\\":\\"望岳街道\\",\\"townid\\":\\"53634\\",\\"detailaddr\\":\\"\\",\\"fullAddress\\":\\"\\",\\"oversea\\":\\"0\\",\\"callType\\":\\"GisService\\",\\"srclng\\":112.93133,\\"srclat\\":28.2351,\\"updateTime\\":0,\\"encryptLng\\":\\"\\",\\"encryptLat\\":\\"\\",\\"gridId\\":0,\\"poi\\":\\"\\",\\"accuracy\\":0}","closeTime":"23:59","startTime":"06:00","receiveStatus":true,"channelId":"2025_18_1482_HUNAN","sourceChannelId":27}'
);
data.append("t", new Date().getTime());
data.append(
  "h5st",
  "20250730135440238;gzxgwpi3d0p0j3j0;1365e;tk03w75511b6518n7S2D3QcQ0QWhRCE44uJSEJTaz0YvZdFGtGsOnTdlzSMZ8JhWsG4r_HDBMdnnCSljDG7YNKiEh1Uf;882bc457a942cdbf2d177b25702ea281;5.1;1753854874238;t6HsMuLU7Goi_trV7KoS3RoQ0RImOGLm_VImOuMsCWbiOGLmAh4WMusmk_MmNlLh1iLi6aYh3ioiNtLh5aYg7OriMt7WIhYhJl4iKdImOGLm_VqTHlYV3lsmOGujMqLi7WLW9a7W_mrhKh4WNdIV_W7W9WYg8abW3Org6S7iMuMgMiXW41YWLlsmOGujMqbjMuMgMebRMlsmOGujMOLj92ch4xZVCJIVPZrUMuMgMWHmOuMsCmcaVlbahBYaaJKmOGLmBxoVApISMusmk_Mm8iLTFRJmOGLmItHmOuMsC6nmOGOiOGLm9qbRMlsmOusmk_Mi9uMgMubi5lImOusmOGuj26sm0mMi9aHWMusmOuMsCmcZ3Ooi8_qcApYVslsm0mcT-dITNlHmOusmOGuj_uMgMObRMlsmOusmk_siOGLm3aHWMusmOuMsCqbiOGLm4aHWMusmOuMsCurm0mch5lImOusmOGuj_uMgMebRMlsmOusmk_si7uMgMibRMlsmOusmk_Mm52ciAuLmOGLm9aHWMusmOuMsCurm0m8U3lsmOusmk_chOGLm79ImOusmOGuj_uMgM_ImOusmOGuj_uMgMe4RMusmOuMsztMgMeITJdnQJlsmOGujxtsmkmsV_eYW6SbW9iIV2qLhPdIUMuMgMmrSMusmOuMsztMgMunSMusmk_Mm6WrQOCrh42YUXt8g_2si9usZgt8S3xoVAJ4ZMuMgMqYR7lsmOG_Q;1c82fcb4bdb6f47655bdcde28ef62002;tenjKJKT-JoRL1YRI9cQKxIWCeYU_tXW"
);
data.append(
  "x-api-eid-token",
  "jdd03F2RMWWMZW5RCVZJON5KCVEHPKBKNGK4MIHLNCMCFN2ZUOG5C54QFODQFWILI355OUE6KTDLKKGDMJW6VB6N2YS5MFMAAAAMYLHQMGPAAAAAACUXN4OTLIBCRMYX"
);

let config = {
  method: "post",
  maxBodyLength: Infinity,
  url: "https://api.m.jd.com/api?fid=bindingQualification",
  headers: {
    "x-auth": "d7f530f0cee9e56eb1b840c5c88a51ca1753174065835711391",
    ...data.getHeaders(),
  },
  data: data,
};

axios
  .request(config)
  .then((response) => {
    console.log(JSON.stringify(response.data));
  })
  .catch((error) => {
    console.log(error);
  });
