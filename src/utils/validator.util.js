function parseHttpUrl(raw) {
  if (!raw) return null;
  try {
    const value = new URL(raw);
    if (value.protocol !== "http:" && value.protocol !== "https:") {
      return null;
    }
    return value.toString();
  } catch {
    return null;
  }
}

function toBoundedInt(value, { min, max }) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const integer = Math.floor(parsed);
  if (integer < min || integer > max) return null;
  return integer;
}

module.exports = {
  parseHttpUrl,
  toBoundedInt
};
