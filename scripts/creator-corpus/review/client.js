// Placeholder client: proves the token flow. The full review page replaces it.
(() => {
  const status = document.getElementById("status");
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  if (!token) {
    status.textContent = "Missing token. Open the URL printed by the command line.";
    return;
  }
  fetch("/api/data", { headers: { Authorization: "Bearer " + token } })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error("request failed"))))
    .then((data) => {
      status.textContent = data.creators.map((creator) => creator.key + ": " + creator.videos.length + " videos").join(" | ");
    })
    .catch(() => {
      status.textContent = "Could not load data.";
    });
})();
