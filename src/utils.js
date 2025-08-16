function generateMailImageUrl(domain) {
  if (domain === "gmail.com") {
    return "/gmail.webp";
  }
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}

module.exports = {
  generateMailImageUrl,
};
