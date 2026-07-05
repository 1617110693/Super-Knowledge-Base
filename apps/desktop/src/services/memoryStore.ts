// Knowledge graph memory system (inspired by CherryStudio's memory MCP server).
// Persisted to memory_graph.json in the data directory via Tauri invoke.

export interface MemoryEntity {
  name: string;           // unique identifier
  entityType: string;     // "person", "preference", "project", "topic", "fact"
  observations: string[]; // facts/observations about this entity
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRelation {
  from: string;           // entity name
  to: string;             // entity name
  relationType: string;   // e.g. "likes", "prefers", "works_on", "related_to"
  createdAt: string;
}

export interface MemoryGraph {
  entities: MemoryEntity[];
  relations: MemoryRelation[];
}

let _graph: MemoryGraph = { entities: [], relations: [] };
let _loaded = false;

// ── Load / Save ──────────────────────────────────────────────────────────

/** Load the memory graph from disk. Must be called once on app startup. */
export async function loadMemoryGraph(): Promise<MemoryGraph> {
  if (_loaded) return _graph;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const data = await invoke<string>("load_memory_graph");
    if (data) {
      _graph = JSON.parse(data);
    }
  } catch {
    // File doesn't exist yet — start with empty graph
    _graph = { entities: [], relations: [] };
  }
  _loaded = true;
  return _graph;
}

async function persistGraph(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_memory_graph", { data: JSON.stringify(_graph, null, 2) });
  } catch (e) {
    console.error("Failed to persist memory graph:", e);
  }
}

// ── CRUD Operations ──────────────────────────────────────────────────────

/** Create new entities. Deduplicates by name — existing entities are NOT overwritten. */
export async function createEntities(entities: { name: string; entityType: string; observations: string[] }[]): Promise<MemoryEntity[]> {
  const now = new Date().toISOString();
  const created: MemoryEntity[] = [];

  for (const e of entities) {
    const existing = _graph.entities.find((x) => x.name === e.name);
    if (existing) continue; // skip duplicates

    const entity: MemoryEntity = {
      name: e.name,
      entityType: e.entityType || "fact",
      observations: e.observations || [],
      createdAt: now,
      updatedAt: now,
    };
    _graph.entities.push(entity);
    created.push(entity);
  }

  if (created.length > 0) await persistGraph();
  return created;
}

/** Create new relations. Both endpoint entities must exist. */
export async function createRelations(relations: { from: string; to: string; relationType: string }[]): Promise<MemoryRelation[]> {
  const now = new Date().toISOString();
  const created: MemoryRelation[] = [];

  for (const r of relations) {
    const fromExists = _graph.entities.some((e) => e.name === r.from);
    const toExists = _graph.entities.some((e) => e.name === r.to);
    if (!fromExists || !toExists) continue; // skip if either endpoint doesn't exist

    // Check for duplicate
    const dup = _graph.relations.find(
      (x) => x.from === r.from && x.to === r.to && x.relationType === r.relationType
    );
    if (dup) continue;

    const rel: MemoryRelation = {
      from: r.from,
      to: r.to,
      relationType: r.relationType || "related_to",
      createdAt: now,
    };
    _graph.relations.push(rel);
    created.push(rel);
  }

  if (created.length > 0) await persistGraph();
  return created;
}

/** Append observations to existing entities. */
export async function addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; added: string[] }[]> {
  const now = new Date().toISOString();
  const results: { entityName: string; added: string[] }[] = [];

  for (const o of observations) {
    const entity = _graph.entities.find((e) => e.name === o.entityName);
    if (!entity) continue;

    const added: string[] = [];
    for (const content of o.contents) {
      if (!entity.observations.includes(content)) {
        entity.observations.push(content);
        added.push(content);
      }
    }
    if (added.length > 0) {
      entity.updatedAt = now;
      results.push({ entityName: o.entityName, added });
    }
  }

  if (results.length > 0) await persistGraph();
  return results;
}

/** Delete entities by name. Cascades to delete their relations. */
export async function deleteEntities(entityNames: string[]): Promise<number> {
  const before = _graph.entities.length;
  _graph.entities = _graph.entities.filter((e) => !entityNames.includes(e.name));
  _graph.relations = _graph.relations.filter(
    (r) => !entityNames.includes(r.from) && !entityNames.includes(r.to)
  );
  const deleted = before - _graph.entities.length;
  if (deleted > 0) await persistGraph();
  return deleted;
}

/** Search entities by query — matches against name, entityType, and observations. */
export async function searchNodes(query: string): Promise<MemoryEntity[]> {
  const q = query.toLowerCase();
  const results = _graph.entities.filter((e) => {
    if (e.name.toLowerCase().includes(q)) return true;
    if (e.entityType.toLowerCase().includes(q)) return true;
    if (e.observations.some((o) => o.toLowerCase().includes(q))) return true;
    return false;
  });

  // Include relations for matched entities
  return results.map((e) => {
    const entityRelations = _graph.relations.filter(
      (r) => r.from === e.name || r.to === e.name
    );
    if (entityRelations.length > 0) {
      return {
        ...e,
        observations: [
          ...e.observations,
          ...entityRelations.map((r) =>
            r.from === e.name
              ? `${r.relationType}: ${r.to}`
              : `${r.to} ${r.relationType}: ${r.from}`
          ),
        ],
      };
    }
    return e;
  });
}

/** Return the full graph (deep copy). */
export function readGraph(): MemoryGraph {
  return {
    entities: _graph.entities.map((e) => ({ ...e, observations: [...e.observations] })),
    relations: _graph.relations.map((r) => ({ ...r })),
  };
}

/** Format the memory graph as a compact string for system prompt injection. */
export function formatMemoryForPrompt(maxChars: number = 2000): string {
  if (_graph.entities.length === 0) return "";

  const lines: string[] = ["USER MEMORY (facts from past conversations):"];
  for (const e of _graph.entities) {
    const obs = e.observations.length > 0 ? `: ${e.observations.join("; ")}` : "";
    lines.push(`- ${e.name} (${e.entityType})${obs}`);
  }

  if (_graph.relations.length > 0) {
    lines.push("Relations:");
    for (const r of _graph.relations) {
      lines.push(`- ${r.from} --[${r.relationType}]--> ${r.to}`);
    }
  }

  let result = lines.join("\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + "\n... (truncated, use search_nodes to find more)";
  }
  return result;
}
