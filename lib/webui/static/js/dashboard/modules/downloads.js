export function createDownloadHelpers({ apiClient, apiPath }) {
  if (!apiClient || typeof apiClient.fetch !== "function") {
    throw new Error("createDownloadHelpers requires an apiClient with fetch()");
  }
  if (typeof apiPath !== "function") {
    throw new Error("createDownloadHelpers requires an apiPath helper");
  }

  function extractFilenameFromDisposition(disposition) {
    if (typeof disposition !== "string" || !disposition) {
      return "";
    }
    const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (filenameMatch && filenameMatch[1]) {
      try {
        return decodeURIComponent(filenameMatch[1]);
      } catch (error) {
        // ignore decode errors and fall back to basic parsing
      }
    }
    const basicMatch = disposition.match(/filename="?([^";]+)"?/i);
    if (basicMatch && basicMatch[1]) {
      return basicMatch[1];
    }
    return "";
  }

  async function downloadRecordingsArchive(paths) {
    if (!Array.isArray(paths) || !paths.length) {
      return;
    }

    const response = await apiClient.fetch(apiPath("/api/recordings/bulk-download"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: paths }),
    });

    if (!response.ok) {
      let message = `Download failed with status ${response.status}`;
      try {
        const errorPayload = await response.json();
        if (typeof errorPayload.error === "string" && errorPayload.error) {
          message = errorPayload.error;
        } else if (Array.isArray(errorPayload.errors) && errorPayload.errors.length) {
          const combined = errorPayload.errors
            .map((entry) => {
              const item = typeof entry.item === "string" ? entry.item : "";
              const errorText = typeof entry.error === "string" ? entry.error : "";
              return item ? `${item}: ${errorText}` : errorText;
            })
            .filter(Boolean)
            .join("\n");
          if (combined) {
            message = combined;
          }
        }
      } catch (error) {
        // ignore parse errors
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition");
    let filename = extractFilenameFromDisposition(disposition);
    if (!filename) {
      const now = new Date();
      if (!Number.isNaN(now.getTime())) {
        const timestamp =
          `${now.getFullYear()}` +
          `${String(now.getMonth() + 1).padStart(2, "0")}` +
          `${String(now.getDate()).padStart(2, "0")}` +
          `-${String(now.getHours()).padStart(2, "0")}` +
          `${String(now.getMinutes()).padStart(2, "0")}` +
          `${String(now.getSeconds()).padStart(2, "0")}`;
        filename = `tricorder-recordings-${timestamp}.zip`;
      } else {
        filename = "tricorder-recordings.zip";
      }
    }

    if (typeof window === "undefined" || !window.URL || !window.document) {
      return;
    }

    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename || "recordings.zip";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      window.URL.revokeObjectURL(blobUrl);
    }, 1000);
  }

  return {
    downloadRecordingsArchive,
  };
}
