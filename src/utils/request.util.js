function getBaseUrl(req) {
  const explicit = process.env.BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  if (req) return `${req.protocol}://${req.get("host")}`;
  return `http://127.0.0.1:${Number(process.env.PORT || 3000)}`;
}

module.exports = {
  getBaseUrl
};
