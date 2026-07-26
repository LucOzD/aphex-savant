// Persistent sample library backed by IndexedDB. Every time you load a file or
// record from the mic, the raw audio data gets stored here so you can recall it
// later without re-importing.

const DB_NAME = "pocket-sampler-lib";
const DB_VERSION = 1;
const STORE = "samples";

export interface SampleEntry {
  /** Auto-incremented ID. */
  id?: number;
  /** Display name (filename or "recording"). */
  name: string;
  /** Raw encoded audio bytes (original file data, not decoded PCM). */
  data: ArrayBuffer;
  /** When it was added (ms since epoch). */
  addedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class SampleLibrary {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    this.db = await openDB();
  }

  /** Store a new sample. Returns the entry with its assigned ID. */
  async add(name: string, data: ArrayBuffer): Promise<SampleEntry> {
    const entry: SampleEntry = { name, data, addedAt: Date.now() };
    const db = this.db!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.add(entry);
      req.onsuccess = () => { entry.id = req.result as number; resolve(entry); };
      req.onerror = () => reject(req.error);
    });
  }

  /** Get all stored samples, newest first. */
  async list(): Promise<SampleEntry[]> {
    const db = this.db!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const entries = req.result as SampleEntry[];
        entries.sort((a, b) => b.addedAt - a.addedAt);
        resolve(entries);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Retrieve a single sample by ID. */
  async get(id: number): Promise<SampleEntry | undefined> {
    const db = this.db!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result as SampleEntry | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  /** Delete a sample by ID. */
  async remove(id: number): Promise<void> {
    const db = this.db!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
