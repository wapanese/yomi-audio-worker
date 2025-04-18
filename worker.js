// Configuration constants
const CONFIG = {
  CACHE_ENABLED: true,
  CACHE_MAX_AGE: 86400,
  PROXY_AUDIO: false,
  REMOVE_FORVO_DUPES: true,
  SOURCE_PROVIDERS: {
    nhk16:
      "https://raw.githubusercontent.com/wapanese/jp_nhk16_pronunciations_tmw/main",
    shinmeikai8:
      "https://raw.githubusercontent.com/wapanese/jp_shinmeikai8_pronunciations_tmw/main",
    jpod: "https://raw.githubusercontent.com/wapanese/jp_jpod_pronunciations_tmw/main",
    forvo:
      "https://raw.githubusercontent.com/wapanese/jp_forvo_pronunciations_tmw/main",
    forvo22:
      "https://raw.githubusercontent.com/wapanese/jp_forvo_pronunciations_2022/main",
    forvo25:
      "https://raw.githubusercontent.com/wapanese/jp_forvo_pronunciations_2025/main",
    daijisen:
      "https://raw.githubusercontent.com/wapanese/daijisen_pronunciations_index/main",
    oubunsha_kogo:
      "https://raw.githubusercontent.com/wapanese/oubunsha_kogo_pronunciations_index/main",
    taas: "https://raw.githubusercontent.com/wapanese/taas_pronunciations_index/main",
  },
  SOURCE_PROVIDERS_NAMES: {
    nhk16: "NHK16",
    shinmeikai8: "SMK8",
    jpod: "JPod101",
    forvo: "Forvo",
    forvo22: "Forvo22",
    forvo25: "Forvo25",
    daijisen: "Daijisen",
    oubunsha_kogo: "Oubunsha-Kogo",
    taas: "TAAS",
  },
};
CONFIG.DEFAULT_SOURCES = Object.keys(CONFIG.SOURCE_PROVIDERS);

let d1_db = null;
let cache = caches.default;

////////////////////////////////////////////////////////////////////////////////////////////////////
// Utility Functions

const log = (...args) => console.log("[YomiAudioServer]", ...args);

function uniqueLowercase(arr) {
  return [...new Set(arr.map((x) => x.toLowerCase()))];
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Source Handling

async function parseRequestedSources(sourceParams) {
  const requestedSources = sourceParams ? sourceParams.split(",") : [];
  const excludedSources = uniqueLowercase(
    requestedSources.filter((s) => s.startsWith("-")).map((s) => s.slice(1))
  );
  const includedSources = uniqueLowercase(
    requestedSources.filter((s) => !s.startsWith("-"))
  );
  const allSources = uniqueLowercase(CONFIG.DEFAULT_SOURCES);

  let finalRequestedSources =
    includedSources.length === 0
      ? allSources.filter((s) => !excludedSources.includes(s))
      : includedSources;

  const requestedDatabaseSources = finalRequestedSources.filter((item) =>
    allSources.includes(item)
  );

  return { requestedDatabaseSources };
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Audio Source Query

function parseName(row) {
  let name =
    CONFIG.SOURCE_PROVIDERS_NAMES[row.source.toLowerCase()] || row.source;
  if (row.speaker) name += ` (${row.speaker})`;
  else if (row.display) name += ` ${row.display}`;
  return name;
}

async function getAudioSources(term, reading, dbSources = []) {
  let query =
    "SELECT source, speaker, display, file, expression, reading FROM entries WHERE expression = ?";
  const params = [term];

  if (dbSources.length > 0) {
    query += " AND source IN (" + dbSources.map(() => "?").join(",") + ")";
    params.push(...dbSources);
  }
  if (reading) {
    query += " AND (reading IS NULL OR reading = ?)";
    params.push(reading);
  }

  const allSources = CONFIG.DEFAULT_SOURCES;
  const orderByList = [
    ...dbSources,
    ...allSources.filter((item) => !dbSources.includes(item)),
  ];

  query += " ORDER BY CASE source";
  orderByList.forEach((src, i) => {
    query += ` WHEN "${src}" THEN ${i + 1}`;
  });
  query += " END, speaker, reading";
  query += " LIMIT 100";

  log("SQL Query:", query, "Params:", params);

  const result = await d1_db
    .prepare(query)
    .bind(...params)
    .all();
  if (!result.results) return [];

  let rows = result.results;

  // Deduplicate Forvo entries
  if (CONFIG.REMOVE_FORVO_DUPES) {
    const forvoSources = CONFIG.DEFAULT_SOURCES.filter((src) =>
      src.startsWith("forvo")
    );
    const seen = new Set();
    rows = rows.filter((row) => {
      if (!forvoSources.includes(row.source)) return true;
      const key = `${row.expression}|${row.reading ?? ""}|${row.speaker ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return rows.map((row) => ({
    name: parseName(row),
    url: `/${row.source}/${row.file}`,
  }));
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// File Fetching

async function fetchAndServeFile(path) {
  const [source, ...rest] = path.split("/");
  const sourceUrl = CONFIG.SOURCE_PROVIDERS[source];
  if (!sourceUrl) return new Response("Invalid source", { status: 400 });
  const fileUrl = `${sourceUrl}/${rest.join("/")}`;
  log("Fetching file:", fileUrl);
  const response = await fetch(fileUrl);
  if (!response.ok) {
    return new Response("File not found", { status: 404 });
  }
  return new Response(response.body, {
    headers: {
      "Content-Disposition": `attachment; filename="${rest.at(-1)}"`,
    },
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Request Handlers

async function handleRootRequest(request) {
  const url = new URL(request.url);
  if (!url.search) return handleBuilderRequest(request);

  const term = url.searchParams.get("term");
  if (!term) return new Response("Missing term parameter", { status: 400 });
  if (term.length > 100) {
    return new Response("Term parameter too long", { status: 400 });
  }
  const reading = url.searchParams.get("reading");
  const { requestedDatabaseSources } = await parseRequestedSources(
    url.searchParams.get("sources")
  );

  let audioSources = [];
  if (requestedDatabaseSources.length > 0) {
    audioSources = await getAudioSources(
      term,
      reading,
      requestedDatabaseSources
    );
  }

  if (CONFIG.PROXY_AUDIO) {
    audioSources = audioSources.map((source) => ({
      ...source,
      url: `https://${url.hostname}${source.url}`,
    }));
  } else {
    audioSources = audioSources.map((source) => {
      const parts = source.url.split("/");
      const providerKey = parts[1];
      const providerUrl = CONFIG.SOURCE_PROVIDERS[providerKey];
      if (!providerUrl) return source;
      const filePath = parts.slice(2).join("/");
      return {
        ...source,
        url: new URL(filePath, providerUrl + "/").toString(),
      };
    });
  }

  // Exclude by display text regex if provided
  const excludeDisplayTextRegex = url.searchParams.get(
    "excludeDisplayTextRegex"
  );
  if (excludeDisplayTextRegex) {
    const regex = new RegExp(excludeDisplayTextRegex, "i");
    audioSources = audioSources.filter((source) => !regex.test(source.name));
  }

  return new Response(
    JSON.stringify({
      type: "audioSourceList",
      audioSources,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

async function handleBuilderRequest(request) {
  const baseUrl = request.url.split("?")[0];
  const sources = CONFIG.DEFAULT_SOURCES;

  const pageSource = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Query Builder</title>
    <style>
      :root {
        --md-sys-color-background: #1c1b1f;
        --md-sys-color-surface: #2a292e;
        --md-sys-color-surface-variant: #49454f;
        --md-sys-color-on-surface: #e6e1e5;
        --md-sys-color-on-surface-variant: #cac4d0;
        --md-sys-color-primary: #a88ee8;
        --md-sys-color-on-primary: #381e72;
        --md-sys-color-secondary: #ccc2dc;
        --md-sys-color-on-secondary: #332d41;
        --md-sys-color-error: #f48a80;
        --md-sys-color-on-error: #601410;
        --md-sys-color-outline: #938f99;

        --md-shape-corner-small: 4px;
        --md-shape-corner-medium: 8px;
        --md-shape-corner-large: 16px;
        --md-shape-corner-full: 999px;

        --indicator-size: 18px;
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      html,
      body {
        height: 100%;
      }

      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue",
          sans-serif;
        background-color: var(--md-sys-color-background);
        color: var(--md-sys-color-on-surface);
        padding: 20px;
        font-size: 16px;
        line-height: 1.5;
      }

      .query-builder-m3 {
        background-color: var(--md-sys-color-surface);
        padding: 24px;
        border-radius: var(--md-shape-corner-large);
        max-width: 800px;
        margin: 20px auto;
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      }

      h1 {
        font-size: 1.75em;
        font-weight: 500;
        margin-bottom: 16px;
        color: var(--md-sys-color-on-surface);
      }

      h2 {
        font-size: 1.1em;
        font-weight: 500;
        margin-top: 24px;
        margin-bottom: 12px;
        color: var(--md-sys-color-on-surface-variant);
        border-bottom: 1px solid var(--md-sys-color-surface-variant);
        padding-bottom: 4px;
      }

      .source-list {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 8px;
      }

      .source-chip {
        display: inline-flex;
        align-items: center;
        padding: 6px 16px 6px 10px;
        border-radius: var(--md-shape-corner-full);
        border: 1px solid var(--md-sys-color-outline);
        background-color: transparent;
        color: var(--md-sys-color-on-surface-variant);
        cursor: pointer;
        user-select: none;
        transition: background-color 0.2s ease, border-color 0.2s ease;
        font-size: 0.9em;
      }

      .source-chip:hover {
        background-color: rgba(255, 255, 255, 0.08);
      }

      .source-chip .status-indicator {
        display: block;
        width: var(--indicator-size);
        height: var(--indicator-size);
        border-radius: 50%;
        margin-right: 8px;
        flex-shrink: 0;
        border: 1.5px solid var(--md-sys-color-outline);
        background-color: transparent;
        transition: background-color 0.2s ease, border-color 0.2s ease;
      }

      .source-chip[data-state="0"] .status-indicator {
        background-color: transparent;
        border-color: var(--md-sys-color-outline);
      }

      .source-chip[data-state="1"] .status-indicator {
        background-color: var(--md-sys-color-primary);
        border-color: var(--md-sys-color-primary);
      }

      .source-chip[data-state="2"] .status-indicator {
        background-color: var(--md-sys-color-error);
        border-color: var(--md-sys-color-error);
      }

      .info-text {
        font-size: 0.85em;
        color: var(--md-sys-color-on-surface-variant);
        margin-bottom: 20px;
        padding-left: 4px;
      }

      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 24px;
      }

      .controls button,
      .output-area button {
        padding: 10px 20px;
        border: none;
        border-radius: var(--md-shape-corner-full);
        cursor: pointer;
        font-size: 0.9em;
        font-weight: 500;
        transition: background-color 0.2s ease, box-shadow 0.2s ease;
        text-transform: none;
      }

      button.filled {
        background-color: var(--md-sys-color-primary);
        color: var(--md-sys-color-on-primary);
      }
      button.filled:hover {
        background-color: #beaaff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      }

      button.outlined {
        background-color: transparent;
        color: var(--md-sys-color-primary);
        border: 1px solid var(--md-sys-color-outline);
      }
      button.outlined:hover {
        background-color: rgba(168, 142, 232, 0.08);
      }

      button.text {
        background-color: transparent;
        color: var(--md-sys-color-primary);
        padding: 10px 12px;
      }
      button.text:hover {
        background-color: rgba(168, 142, 232, 0.08);
      }

      button.error {
        background-color: var(--md-sys-color-error);
        color: var(--md-sys-color-on-error);
      }
      button.error:hover {
        background-color: #f7a39b;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      }

      .input-group {
        margin-bottom: 24px;
      }
      .input-group label {
        display: block;
        margin-bottom: 8px;
        font-size: 0.9em;
        color: var(--md-sys-color-on-surface-variant);
      }
      .input-group input[type="text"] {
        width: 100%;
        padding: 12px 16px;
        background-color: var(--md-sys-color-surface-variant);
        color: var(--md-sys-color-on-surface);
        border: 1px solid transparent;
        border-radius: var(--md-shape-corner-small) var(--md-shape-corner-small)
          0 0;
        font-family: inherit;
        font-size: 0.95em;
        outline: none;
        border-bottom: 1px solid var(--md-sys-color-outline);
        transition: border-color 0.2s ease, background-color 0.2s ease;
      }
      .input-group input[type="text"]:focus {
        background-color: var(--md-sys-color-surface);
        border-bottom: 2px solid var(--md-sys-color-primary);
      }

      .output-area {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      #outputUrl {
        flex-grow: 1;
        padding: 12px 16px;
        background-color: var(--md-sys-color-surface-variant);
        color: var(--md-sys-color-on-surface);
        border: 1px solid var(--md-sys-color-outline);
        border-radius: var(--md-shape-corner-medium);
        font-family: inherit;
        font-size: 0.9em;
        resize: vertical;
        min-height: 80px;
        outline: none;
      }
      #outputUrl:focus {
        border-color: var(--md-sys-color-primary);
      }

      #copyButton {
        flex-shrink: 0;
        min-width: 95px;
        text-align: center;
      }
      #copyButton.copied {
        background-color: var(--md-sys-color-secondary);
        color: var(--md-sys-color-on-secondary);
      }
    </style>
  </head>
  <body>
    <div class="query-builder-m3">
      <h1>Query Builder</h1>

      <h2>Select Sources</h2>
      <div id="sourceList" class="source-list"></div>
      <p class="info-text">
        Click sources to cycle state: Neutral (outline) → Include (filled
        purple) → Exclude (filled red). <br />
        If no sources are explicitly included, all available sources will be
        used. <br />
      </p>

      <div class="controls">
        <button id="selectAllButton" class="filled">Include All</button>
        <button id="deselectAllButton" class="outlined">Neutral All</button>
        <button id="excludeAllButton" class="error">Exclude All</button>
      </div>

      <div class="input-group">
        <label for="regexFilterInput"
          >Exclude results matching Regex (on display text)</label
        >
        <input
          type="text"
          id="regexFilterInput"
          placeholder="e.g. ^TTS"
        />
      </div>

      <h2>Query URL</h2>
      <div class="output-area">
        <textarea id="outputUrl" readonly rows="4"></textarea>
        <button id="copyButton" class="filled">Copy</button>
      </div>
    </div>

    <script>
      document.addEventListener("DOMContentLoaded", () => {
        const availableSources = AVAILABLE_SOURCES_PLACEHOLDER;

        const sourceStates = {};
        availableSources.forEach((source) => {
          sourceStates[source] = 0;
        });

        const sourceListContainer = document.getElementById("sourceList");
        const regexFilterInput = document.getElementById("regexFilterInput");
        const outputUrlTextArea = document.getElementById("outputUrl");
        const selectAllButton = document.getElementById("selectAllButton");
        const deselectAllButton = document.getElementById("deselectAllButton");
        const excludeAllButton = document.getElementById("excludeAllButton");
        const copyButton = document.getElementById("copyButton");

        const baseApiUrl = "BASE_API_URL_PLACEHOLDER";

        function renderSources() {
          sourceListContainer.innerHTML = "";
          availableSources.forEach((source) => {
            const chip = document.createElement("div");
            chip.classList.add("source-chip");
            chip.setAttribute("data-source", source);

            const statusIndicator = document.createElement("span");
            statusIndicator.classList.add("status-indicator");

            const textNode = document.createTextNode(source);

            chip.appendChild(statusIndicator);
            chip.appendChild(textNode);

            chip.addEventListener("click", () => {
              toggleSourceState(source);
              updateUrl();
            });

            sourceListContainer.appendChild(chip);
            updateChipVisual(source);
          });
        }

        function toggleSourceState(source) {
          sourceStates[source] = (sourceStates[source] + 1) % 3;
          updateChipVisual(source);
        }

        function setAllSourcesState(state) {
          Object.keys(sourceStates).forEach((source) => {
            sourceStates[source] = state;
            updateChipVisual(source);
          });
          updateUrl();
        }

        function updateChipVisual(source) {
          const chip = sourceListContainer.querySelector(
            \`.source-chip[data-source="\${source}"]\`
          );
          if (chip) {
            chip.setAttribute("data-state", sourceStates[source]);
          }
        }

        function generateUrl() {
          const included = [];
          const excluded = [];

          availableSources.forEach((source) => {
            if (sourceStates[source] === 1) {
              included.push(source);
            } else if (sourceStates[source] === 2) {
              excluded.push(\`-\${source}\`);
            }
          });

          const sourcesParamArray = [...included, ...excluded];
          let finalUrl = baseApiUrl;

          if (sourcesParamArray.length > 0) {
            finalUrl += \`&sources=\${sourcesParamArray.join(",")}\`;
          }

          const regexValue = regexFilterInput.value.trim();
          if (regexValue) {
            finalUrl += \`&excludeDisplayTextRegex=\${encodeURIComponent(
              regexValue
            )}\`;
          }

          return finalUrl;
        }

        function updateUrl() {
          outputUrlTextArea.value = generateUrl();
        }

        function copyUrlToClipboard() {
          if (!outputUrlTextArea.value) return;
          outputUrlTextArea.select();
          try {
            document.execCommand("copy");
            copyButton.textContent = "Copied!";
            copyButton.classList.add("copied");
            setTimeout(() => {
              copyButton.textContent = "Copy";
              copyButton.classList.remove("copied");
            }, 1500);
          } catch (err) {
            console.error("Failed to copy URL: ", err);
            alert("Failed to copy URL automatically. Please copy it manually.");
          }
          window.getSelection().removeAllRanges();
        }

        selectAllButton.addEventListener("click", () => setAllSourcesState(1));
        deselectAllButton.addEventListener("click", () =>
          setAllSourcesState(0)
        );
        excludeAllButton.addEventListener("click", () => setAllSourcesState(2));
        regexFilterInput.addEventListener("input", updateUrl);
        copyButton.addEventListener("click", copyUrlToClipboard);

        renderSources();
        updateUrl();
      });
    <\/script>
  </body>
</html>
  `
    .replace("AVAILABLE_SOURCES_PLACEHOLDER", JSON.stringify(sources))
    .replace(
      "BASE_API_URL_PLACEHOLDER",
      `${baseUrl}?term={term}&reading={reading}`
    );
  return new Response(pageSource, {
    headers: { "Content-Type": "text/html" },
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Caching & CORS

function withCORSHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Main Request Routing

async function routeRequest(request, env, ctx) {
  d1_db = env.DB;
  try {
    const url = new URL(request.url);
    if (url.pathname === "/") return handleRootRequest(request);
    return fetchAndServeFile(url.pathname.slice(1));
  } catch (error) {
    log("An error occurred:", error);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}

async function handleRequest(request, env, ctx) {
  if (!CONFIG.CACHE_ENABLED) return routeRequest(request, env, ctx);

  const cacheKey = new Request(request.url, { method: request.method });
  const cached = await cache.match(cacheKey);
  if (cached) {
    log("Cache hit");
    return cached;
  }
  log("Cache miss");

  let response = await routeRequest(request, env, ctx);

  if (request.method === "GET") {
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers),
        "Cache-Control": `max-age=${CONFIG.CACHE_MAX_AGE}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

async function handleFetch(request, env, ctx) {
  if (request.method === "OPTIONS") return optionsResponse();
  const response = await handleRequest(request, env, ctx);
  return withCORSHeaders(response);
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Entrypoint

export default {
  fetch: handleFetch,
};
