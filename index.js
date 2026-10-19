import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const YANDEX_TOKEN = process.env.YANDEX_DISK_TOKEN;
const CONNECTOR_SECRET = process.env.CONNECTOR_SECRET; // используется как секретный кусок URL

if (!YANDEX_TOKEN) {
  console.error("ОШИБКА: не задана переменная окружения YANDEX_DISK_TOKEN");
  process.exit(1);
}
if (!CONNECTOR_SECRET) {
  console.error("ОШИБКА: не задана переменная окружения CONNECTOR_SECRET");
  process.exit(1);
}

const API_BASE = "https://cloud-api.yandex.net/v1/disk";

async function yandexFetch(path, { method = "GET", query = {}, body } = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `OAuth ${YANDEX_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `Yandex Disk API error ${res.status}: ${data.message || data.description || text}`
    );
  }
  return data;
}

function buildServer() {
  const server = new McpServer({
    name: "yandex-disk",
    version: "1.0.0",
  });

  server.registerTool(
    "list_files",
    {
      title: "Список файлов и папок",
      description:
        "Показать содержимое папки на Яндекс.Диске. path по умолчанию '/' (корень диска).",
      inputSchema: {
        path: z.string().default("/").describe("Путь к папке, например '/Документы'"),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ path, limit }) => {
      const data = await yandexFetch("/resources", {
        query: { path, limit, fields: "_embedded.items.name,_embedded.items.path,_embedded.items.type,_embedded.items.size,_embedded.items.modified" },
      });
      const items = data._embedded?.items ?? [];
      const summary = items
        .map((i) => `${i.type === "dir" ? "[папка]" : "[файл]"} ${i.path} ${i.size ? `(${i.size} байт)` : ""}`)
        .join("\n");
      return {
        content: [{ type: "text", text: summary || "Папка пуста." }],
      };
    }
  );

  server.registerTool(
    "get_file_info",
    {
      title: "Информация о файле или папке",
      description: "Получить метаданные (размер, дата изменения, тип, MIME) по пути на Диске.",
      inputSchema: { path: z.string().describe("Путь к файлу или папке") },
    },
    async ({ path }) => {
      const data = await yandexFetch("/resources", { query: { path } });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_download_link",
    {
      title: "Ссылка на скачивание файла",
      description: "Получить временную прямую ссылку для скачивания конкретного файла с Диска.",
      inputSchema: { path: z.string().describe("Путь к файлу") },
    },
    async ({ path }) => {
      const data = await yandexFetch("/resources/download", { query: { path } });
      return {
        content: [{ type: "text", text: data.href || "Ссылка не получена." }],
      };
    }
  );

  server.registerTool(
    "get_image_data",
    {
      title: "Картинка как data URL",
      description:
        "Скачать изображение с Диска на сервере и вернуть его как data:URL (base64), который можно вставить прямо в <img src> без CORS. Используй для фото к постам вместо ссылки на скачивание. Поддерживает jpg/png/webp; крупные файлы сервер сам ужимает.",
      inputSchema: { path: z.string().describe("Путь к изображению на Диске") },
    },
    async ({ path }) => {
      const dl = await yandexFetch("/resources/download", { query: { path } });
      if (!dl.href) throw new Error("Не удалось получить ссылку на скачивание.");
      const r = await fetch(dl.href);
      if (!r.ok) throw new Error(`Скачивание не удалось: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const lower = path.toLowerCase();
      const mime = lower.endsWith(".png")
        ? "image/png"
        : lower.endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
      // сервер не гарантирует ресайз, но защищаемся от гигантских файлов
      if (buf.length > 4_500_000) {
        return {
          content: [
            {
              type: "text",
              text: `Файл слишком большой для data URL (${buf.length} байт). Дай ссылку через get_download_link или выбери файл поменьше.`,
            },
          ],
        };
      }
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      return { content: [{ type: "text", text: dataUrl }] };
    }
  );

  server.registerTool(
    "read_document",
    {
      title: "Прочитать текст документа",
      description:
        "Скачать документ с Диска на сервере и вернуть его ТЕКСТ (без CORS-ограничений браузера). Поддерживает .docx, .txt, .md, .csv. Используй это вместо ссылки на скачивание, когда нужно прочитать содержимое файла (например «Краткое описание.docx»).",
      inputSchema: { path: z.string().describe("Путь к файлу на Диске") },
    },
    async ({ path }) => {
      const dl = await yandexFetch("/resources/download", { query: { path } });
      if (!dl.href) throw new Error("Не удалось получить ссылку на скачивание.");
      const r = await fetch(dl.href);
      if (!r.ok) throw new Error(`Скачивание не удалось: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const lower = path.toLowerCase();
      let text;
      if (lower.endsWith(".docx")) {
        const mammoth = await import("mammoth");
        const out = await mammoth.extractRawText({ buffer: buf });
        text = out.value;
      } else if (
        lower.endsWith(".txt") ||
        lower.endsWith(".md") ||
        lower.endsWith(".csv")
      ) {
        text = buf.toString("utf8");
      } else {
        text = `Чтение текста для этого формата пока не поддерживается: ${path}. Поддержаны .docx, .txt, .md, .csv.`;
      }
      if (text && text.length > 40000) text = text.slice(0, 40000) + "\n…(обрезано)";
      return { content: [{ type: "text", text: text || "Документ пуст." }] };
    }
  );

  server.registerTool(
    "upload_from_url",
    {
      title: "Загрузить файл на Диск по внешней ссылке",
      description:
        "Скопировать файл с произвольного URL прямо на Яндекс.Диск (без передачи содержимого через чат). Полезно для картинок/документов, на которые есть прямая ссылка.",
      inputSchema: {
        url: z.string().url().describe("Прямая ссылка на файл"),
        path: z.string().describe("Путь назначения на Диске, например '/Загрузки/файл.jpg'"),
      },
    },
    async ({ url, path }) => {
      const data = await yandexFetch("/resources/upload", {
        method: "POST",
        query: { url, path },
      });
      return {
        content: [
          {
            type: "text",
            text: `Загрузка запущена. operation_id: ${data.operation_id || "нет"}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "create_folder",
    {
      title: "Создать папку",
      description: "Создать новую папку по указанному пути на Диске.",
      inputSchema: { path: z.string().describe("Путь новой папки") },
    },
    async ({ path }) => {
      await yandexFetch("/resources", { method: "PUT", query: { path } });
      return { content: [{ type: "text", text: `Папка ${path} создана.` }] };
    }
  );

  server.registerTool(
    "delete_resource",
    {
      title: "Удалить файл или папку",
      description: "Удалить файл или папку. По умолчанию — в корзину, не безвозвратно.",
      inputSchema: {
        path: z.string(),
        permanently: z.boolean().default(false),
      },
    },
    async ({ path, permanently }) => {
      await yandexFetch("/resources", {
        method: "DELETE",
        query: { path, permanently },
      });
      return {
        content: [
          {
            type: "text",
            text: `${path} удалён${permanently ? " безвозвратно" : " (перемещён в корзину)"}.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_public_link",
    {
      title: "Получить публичную ссылку",
      description: "Опубликовать файл/папку и получить публичную ссылку для отправки другим людям.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      await yandexFetch("/resources/publish", { method: "PUT", query: { path } });
      const data = await yandexFetch("/resources", { query: { path, fields: "public_url" } });
      return {
        content: [{ type: "text", text: data.public_url || "Ссылка не найдена после публикации." }],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Секретный сегмент пути защищает сервер: без него запросы отклоняются
app.post(`/mcp/${CONNECTOR_SECRET}`, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", message: String(err.message || err) });
    }
  }
});

// Прямая отдача изображений (минуя модель и CORS браузера).
// Картинка стримится байтами с заголовком CORS — годится и для <img>, и для fetch, и для Telegram.
app.get(`/img/${CONNECTOR_SECRET}`, async (req, res) => {
  try {
    const p = req.query.path;
    if (!p) return res.status(400).send("no path");
    const dl = await yandexFetch("/resources/download", { query: { path: p } });
    if (!dl.href) return res.status(404).send("file not found");
    const r = await fetch(dl.href);
    if (!r.ok) return res.status(502).send("download failed");
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(buf);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

app.get("/", (req, res) => {
  res.send("Yandex Disk MCP server is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Yandex Disk MCP server listening on port ${PORT}`);
});
