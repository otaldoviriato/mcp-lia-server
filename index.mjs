import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { MongoClient } from "mongodb";

const server = new McpServer({
  name: "liaclinics-project-server",
  version: "1.1.0",
});

// ── Config ────────────────────────────────────────────────────────────────────
const ROOT_DIR = "C:/Users/viria/Documents/lia/lia-clinics";

let mongoClient = null;
let mongoUri = process.env.MONGODB_URI || "";

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolvePath(p) {
  const resolved = path.resolve(ROOT_DIR, p);
  if (!resolved.startsWith(path.resolve(ROOT_DIR))) {
    throw new Error("Access denied: path outside project root.");
  }
  return resolved;
}

async function getMongoClient() {
  if (!mongoUri) throw new Error("MongoDB URI not configured. Use mongo_connect or set MONGODB_URI env var.");
  if (!mongoClient) {
    mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });
    await mongoClient.connect();
  }
  return mongoClient;
}

function mcpError(message) {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

// ── File Tools ────────────────────────────────────────────────────────────────

server.registerTool(
  "read_file",
  {
    title: "Read File",
    description: "Read the content of a file inside the lia-clinics project",
    inputSchema: {
      filePath: z.string().describe("Relative path from project root (e.g., 'app/page.tsx')"),
    },
  },
  async ({ filePath }) => {
    try {
      const content = await fs.readFile(resolvePath(filePath), "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "write_file",
  {
    title: "Write File",
    description: "Write (or overwrite) a file inside the lia-clinics project",
    inputSchema: {
      filePath: z.string().describe("Relative path to the file to write"),
      content:  z.string().describe("Full content to write to the file"),
    },
  },
  async ({ filePath, content }) => {
    try {
      const resolved = resolvePath(filePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf-8");
      return { content: [{ type: "text", text: `Written: ${filePath}` }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "delete_file",
  {
    title: "Delete File",
    description: "Delete a file or empty directory inside the lia-clinics project",
    inputSchema: {
      filePath: z.string().describe("Relative path to the file or empty directory to delete"),
    },
  },
  async ({ filePath }) => {
    try {
      await fs.rm(resolvePath(filePath), { recursive: false });
      return { content: [{ type: "text", text: `Deleted: ${filePath}` }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "list_directory",
  {
    title: "List Directory",
    description: "List files and folders in a directory inside the lia-clinics project",
    inputSchema: {
      dirPath: z.string().describe("Relative path to the directory (use '.' for project root)"),
    },
  },
  async ({ dirPath }) => {
    try {
      const items = await fs.readdir(resolvePath(dirPath), { withFileTypes: true });
      const text = items
        .map(i => `${i.isDirectory() ? "[DIR] " : "[FILE]"} ${i.name}`)
        .join("\n");
      return { content: [{ type: "text", text: text || "Empty directory." }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "get_project_tree",
  {
    title: "Get Project Tree",
    description: "Recursively list the project file tree, with optional depth limit and ignore patterns",
    inputSchema: {
      dirPath:    z.string().optional().describe("Sub-directory to start from (default: '.')"),
      maxDepth:   z.number().optional().describe("Max depth to recurse (default: 4)"),
      ignoreList: z.array(z.string()).optional().describe("Directory/file names to skip (default: node_modules, .git, .next, dist)"),
    },
  },
  async ({ dirPath = ".", maxDepth = 4, ignoreList }) => {
    const defaultIgnore = ["node_modules", ".git", ".next", "dist", ".turbo", "build", "out", ".cache"];
    const ignored = new Set(ignoreList ?? defaultIgnore);

    async function walk(abs, rel, depth) {
      if (depth > maxDepth) return [];
      let items;
      try { items = await fs.readdir(abs, { withFileTypes: true }); }
      catch { return []; }
      const lines = [];
      for (const item of items) {
        if (ignored.has(item.name)) continue;
        const prefix = "  ".repeat(depth);
        if (item.isDirectory()) {
          lines.push(`${prefix}[DIR]  ${item.name}/`);
          lines.push(...await walk(path.join(abs, item.name), path.join(rel, item.name), depth + 1));
        } else {
          lines.push(`${prefix}[FILE] ${item.name}`);
        }
      }
      return lines;
    }

    try {
      const lines = await walk(resolvePath(dirPath), dirPath, 0);
      return { content: [{ type: "text", text: lines.join("\n") || "Empty." }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "search_files",
  {
    title: "Search Files",
    description: "Search for a text pattern (substring or regex) in project files",
    inputSchema: {
      pattern:   z.string().describe("Text or regex pattern to search for"),
      dirPath:   z.string().optional().describe("Sub-directory to search in (default: '.')"),
      fileGlob:  z.string().optional().describe("File extension filter, e.g. '.tsx' or '.ts' (default: all text files)"),
      maxResults: z.number().optional().describe("Max matching lines to return (default: 50)"),
    },
  },
  async ({ pattern, dirPath = ".", fileGlob, maxResults = 50 }) => {
    const results = [];
    let regex;
    try { regex = new RegExp(pattern, "i"); }
    catch { return mcpError(`Invalid regex: ${pattern}`); }

    async function walk(abs) {
      if (results.length >= maxResults) return;
      let items;
      try { items = await fs.readdir(abs, { withFileTypes: true }); }
      catch { return; }
      for (const item of items) {
        if (["node_modules", ".git", ".next", "dist"].includes(item.name)) continue;
        const fullPath = path.join(abs, item.name);
        if (item.isDirectory()) {
          await walk(fullPath);
        } else {
          if (fileGlob && !item.name.endsWith(fileGlob)) continue;
          try {
            const text = await fs.readFile(fullPath, "utf-8");
            const lines = text.split("\n");
            lines.forEach((line, idx) => {
              if (results.length < maxResults && regex.test(line)) {
                const rel = path.relative(resolvePath(dirPath), fullPath).replace(/\\/g, "/");
                results.push(`${rel}:${idx + 1}: ${line.trim()}`);
              }
            });
          } catch { /* skip binary files */ }
        }
      }
    }

    try {
      await walk(resolvePath(dirPath));
      const text = results.length > 0
        ? results.join("\n")
        : `No matches found for: ${pattern}`;
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

// ── MongoDB Tools ─────────────────────────────────────────────────────────────

server.registerTool(
  "mongo_connect",
  {
    title: "MongoDB Connect",
    description: "Set the MongoDB connection URI and test the connection",
    inputSchema: {
      uri: z.string().describe("MongoDB connection string (e.g., mongodb+srv://user:pass@cluster...)"),
    },
  },
  async ({ uri }) => {
    try {
      if (mongoClient) { await mongoClient.close(); mongoClient = null; }
      mongoUri = uri;
      const client = await getMongoClient();
      await client.db("admin").command({ ping: 1 });
      return { content: [{ type: "text", text: "MongoDB connected successfully." }] };
    } catch (e) {
      mongoClient = null;
      mongoUri = "";
      return mcpError(`Connection failed: ${e.message}`);
    }
  }
);

server.registerTool(
  "mongo_list_databases",
  {
    title: "List Databases",
    description: "List all databases in the MongoDB cluster",
    inputSchema: {},
  },
  async () => {
    try {
      const client = await getMongoClient();
      const result = await client.db("admin").command({ listDatabases: 1 });
      const text = result.databases.map(d => `${d.name} (${(d.sizeOnDisk / 1024).toFixed(1)} KB)`).join("\n");
      return { content: [{ type: "text", text: text || "No databases found." }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "mongo_list_collections",
  {
    title: "List Collections",
    description: "List all collections in a MongoDB database",
    inputSchema: {
      database: z.string().describe("Database name"),
    },
  },
  async ({ database }) => {
    try {
      const client = await getMongoClient();
      const cols = await client.db(database).listCollections().toArray();
      const text = cols.map(c => c.name).join("\n") || "No collections found.";
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "mongo_find",
  {
    title: "MongoDB Find",
    description: "Find documents in a MongoDB collection",
    inputSchema: {
      database:   z.string().describe("Database name"),
      collection: z.string().describe("Collection name"),
      filter:     z.record(z.any()).optional().describe("MongoDB filter query (default: {})"),
      projection: z.record(z.any()).optional().describe("Fields to include/exclude"),
      limit:      z.number().optional().describe("Max documents to return (default: 20)"),
      sort:       z.record(z.any()).optional().describe("Sort criteria (e.g., { createdAt: -1 })"),
    },
  },
  async ({ database, collection, filter, projection, limit, sort }) => {
    try {
      const client = await getMongoClient();
      let cursor = client.db(database).collection(collection).find(filter || {});
      if (projection) cursor = cursor.project(projection);
      if (sort) cursor = cursor.sort(sort);
      const docs = await cursor.limit(limit ?? 20).toArray();
      return { content: [{ type: "text", text: JSON.stringify(docs, null, 2) }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "mongo_count",
  {
    title: "MongoDB Count",
    description: "Count documents in a MongoDB collection matching a filter",
    inputSchema: {
      database:   z.string().describe("Database name"),
      collection: z.string().describe("Collection name"),
      filter:     z.record(z.any()).optional().describe("MongoDB filter query (default: {})"),
    },
  },
  async ({ database, collection, filter }) => {
    try {
      const client = await getMongoClient();
      const count = await client.db(database).collection(collection).countDocuments(filter || {});
      return { content: [{ type: "text", text: `Count: ${count}` }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "mongo_insert_one",
  {
    title: "MongoDB Insert One",
    description: "Insert a single document into a MongoDB collection",
    inputSchema: {
      database:   z.string().describe("Database name"),
      collection: z.string().describe("Collection name"),
      document:   z.record(z.any()).describe("Document to insert"),
    },
  },
  async ({ database, collection, document }) => {
    try {
      const client = await getMongoClient();
      const result = await client
        .db(database)
        .collection(collection)
        .insertOne({ ...document, createdAt: new Date() });
      return { content: [{ type: "text", text: `Inserted _id: ${result.insertedId}` }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "mongo_update_one",
  {
    title: "MongoDB Update One",
    description: "Update a single document in a MongoDB collection",
    inputSchema: {
      database:   z.string().describe("Database name"),
      collection: z.string().describe("Collection name"),
      filter:     z.record(z.any()).describe("Filter to find the document"),
      update:     z.record(z.any()).describe("Update operation (e.g., { $set: { field: value } })"),
      upsert:     z.boolean().optional().describe("Insert if not found (default: false)"),
    },
  },
  async ({ database, collection, filter, update, upsert }) => {
    try {
      const client = await getMongoClient();
      const result = await client.db(database).collection(collection).updateOne(filter, update, { upsert: upsert ?? false });
      return { content: [{ type: "text", text: `Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}, Upserted: ${result.upsertedCount}` }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "mongo_update_many",
  {
    title: "MongoDB Update Many",
    description: "Update multiple documents in a MongoDB collection",
    inputSchema: {
      database:   z.string().describe("Database name"),
      collection: z.string().describe("Collection name"),
      filter:     z.record(z.any()).describe("Filter to find documents"),
      update:     z.record(z.any()).describe("Update operation (e.g., { $set: { field: value } })"),
    },
  },
  async ({ database, collection, filter, update }) => {
    try {
      const client = await getMongoClient();
      const result = await client.db(database).collection(collection).updateMany(filter, update);
      return { content: [{ type: "text", text: `Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}` }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "mongo_delete_one",
  {
    title: "MongoDB Delete One",
    description: "Delete a single document from a MongoDB collection",
    inputSchema: {
      database:   z.string().describe("Database name"),
      collection: z.string().describe("Collection name"),
      filter:     z.record(z.any()).describe("Filter to find the document to delete"),
    },
  },
  async ({ database, collection, filter }) => {
    try {
      const client = await getMongoClient();
      const result = await client.db(database).collection(collection).deleteOne(filter);
      return { content: [{ type: "text", text: `Deleted: ${result.deletedCount} document(s)` }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

server.registerTool(
  "mongo_aggregate",
  {
    title: "MongoDB Aggregate",
    description: "Run an aggregation pipeline on a MongoDB collection",
    inputSchema: {
      database:   z.string().describe("Database name"),
      collection: z.string().describe("Collection name"),
      pipeline:   z.array(z.record(z.any())).describe("Aggregation pipeline stages"),
    },
  },
  async ({ database, collection, pipeline }) => {
    try {
      const client = await getMongoClient();
      const results = await client.db(database).collection(collection).aggregate(pipeline).toArray();
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (e) {
      return mcpError(e.message);
    }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
async function main() {
  // Auto-connect if URI is already set via env var
  if (mongoUri) {
    try {
      await getMongoClient();
      await mongoClient.db("admin").command({ ping: 1 });
      console.error("MongoDB auto-connected via MONGODB_URI env var.");
    } catch (e) {
      console.error(`MongoDB auto-connect failed: ${e.message}`);
      mongoClient = null;
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Lia Clinics MCP Server v1.1.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
