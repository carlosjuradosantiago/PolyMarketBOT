// ─── IndexedDB Database Service ─────────────────────────────────────────
// Persiste órdenes, historial, balance y configuración localmente

const DB_NAME = "polymarket_bot_db";
const DB_VERSION = 1;

interface DBOrder {
  id: string;
  marketId: string;
  conditionId: string;
  marketQuestion: string;
  outcome: string;
  outcomeIndex: number;
  side: string;
  price: number;
  quantity: number;
  totalCost: number;
  potentialPayout: number;
  status: string;
  createdAt: string;
  resolvedAt?: string;
  pnl?: number;
  resolutionPrice?: number;
}

interface DBBalanceSnapshot {
  id?: number;
  timestamp: string;
  balance: number;
  totalPnl: number;
  openOrdersCount: number;
  openOrdersValue: number;
}

interface DBConfig {
  key: string;
  value: string;
}

interface DBTradeSummary {
  id?: number;
  date: string;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
}

let db: IDBDatabase | null = null;

// ─── Initialize Database ─────────────────────────────────────────

export async function initDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error("Error opening database:", request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      console.log("✅ Database initialized");
      resolve();
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;

      // Orders store
      if (!database.objectStoreNames.contains("orders")) {
        const ordersStore = database.createObjectStore("orders", { keyPath: "id" });
        ordersStore.createIndex("status", "status", { unique: false });
        ordersStore.createIndex("marketId", "marketId", { unique: false });
        ordersStore.createIndex("createdAt", "createdAt", { unique: false });
      }

      // Balance snapshots store
      if (!database.objectStoreNames.contains("balanceSnapshots")) {
        const balanceStore = database.createObjectStore("balanceSnapshots", { 
          keyPath: "id", 
          autoIncrement: true 
        });
        balanceStore.createIndex("timestamp", "timestamp", { unique: false });
      }

      // Config store
      if (!database.objectStoreNames.contains("config")) {
        database.createObjectStore("config", { keyPath: "key" });
      }

      // Trade summaries (daily)
      if (!database.objectStoreNames.contains("tradeSummaries")) {
        const summaryStore = database.createObjectStore("tradeSummaries", { 
          keyPath: "id", 
          autoIncrement: true 
        });
        summaryStore.createIndex("date", "date", { unique: true });
      }

      // Activity log
      if (!database.objectStoreNames.contains("activityLog")) {
        const activityStore = database.createObjectStore("activityLog", { 
          keyPath: "id", 
          autoIncrement: true 
        });
        activityStore.createIndex("timestamp", "timestamp", { unique: false });
      }

      console.log("📦 Database schema created/upgraded");
    };
  });
}

// ─── Orders CRUD ─────────────────────────────────────────

export async function saveOrder(order: DBOrder): Promise<void> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["orders"], "readwrite");
    const store = transaction.objectStore("orders");
    const request = store.put(order);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getOrder(id: string): Promise<DBOrder | undefined> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["orders"], "readonly");
    const store = transaction.objectStore("orders");
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllOrders(): Promise<DBOrder[]> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["orders"], "readonly");
    const store = transaction.objectStore("orders");
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getOrdersByStatus(status: string): Promise<DBOrder[]> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["orders"], "readonly");
    const store = transaction.objectStore("orders");
    const index = store.index("status");
    const request = index.getAll(status);

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteOrder(id: string): Promise<void> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["orders"], "readwrite");
    const store = transaction.objectStore("orders");
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clearAllOrders(): Promise<void> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["orders"], "readwrite");
    const store = transaction.objectStore("orders");
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ─── Balance Snapshots ─────────────────────────────────────────

export async function saveBalanceSnapshot(snapshot: Omit<DBBalanceSnapshot, "id">): Promise<void> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["balanceSnapshots"], "readwrite");
    const store = transaction.objectStore("balanceSnapshots");
    const request = store.add(snapshot);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getBalanceSnapshots(limit: number = 100): Promise<DBBalanceSnapshot[]> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["balanceSnapshots"], "readonly");
    const store = transaction.objectStore("balanceSnapshots");
    const request = store.getAll();

    request.onsuccess = () => {
      const results = request.result || [];
      // Return latest entries
      resolve(results.slice(-limit));
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearBalanceSnapshots(): Promise<void> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["balanceSnapshots"], "readwrite");
    const store = transaction.objectStore("balanceSnapshots");
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ─── Config ─────────────────────────────────────────

export async function saveConfig(key: string, value: any): Promise<void> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["config"], "readwrite");
    const store = transaction.objectStore("config");
    const request = store.put({ key, value: JSON.stringify(value) });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getConfig<T>(key: string, defaultValue: T): Promise<T> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["config"], "readonly");
    const store = transaction.objectStore("config");
    const request = store.get(key);

    request.onsuccess = () => {
      if (request.result) {
        try {
          resolve(JSON.parse(request.result.value));
        } catch {
          resolve(defaultValue);
        }
      } else {
        resolve(defaultValue);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

// ─── Activity Log ─────────────────────────────────────────

export async function saveActivity(entry: { timestamp: string; message: string; type: string }): Promise<void> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["activityLog"], "readwrite");
    const store = transaction.objectStore("activityLog");
    const request = store.add(entry);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getActivityLog(limit: number = 200): Promise<any[]> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["activityLog"], "readonly");
    const store = transaction.objectStore("activityLog");
    const request = store.getAll();

    request.onsuccess = () => {
      const results = request.result || [];
      resolve(results.slice(-limit));
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearActivityLog(): Promise<void> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["activityLog"], "readwrite");
    const store = transaction.objectStore("activityLog");
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ─── Trade Summaries ─────────────────────────────────────────

export async function saveTradeSummary(summary: Omit<DBTradeSummary, "id">): Promise<void> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["tradeSummaries"], "readwrite");
    const store = transaction.objectStore("tradeSummaries");
    
    // Check if exists for this date
    const index = store.index("date");
    const getRequest = index.get(summary.date);
    
    getRequest.onsuccess = () => {
      if (getRequest.result) {
        // Update existing
        const updated = { ...getRequest.result, ...summary };
        store.put(updated);
      } else {
        // Add new
        store.add(summary);
      }
      resolve();
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

export async function getTradeSummaries(days: number = 30): Promise<DBTradeSummary[]> {
  if (!db) await initDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(["tradeSummaries"], "readonly");
    const store = transaction.objectStore("tradeSummaries");
    const request = store.getAll();

    request.onsuccess = () => {
      const results = request.result || [];
      resolve(results.slice(-days));
    };
    request.onerror = () => reject(request.error);
  });
}

// ─── Reset All Data ─────────────────────────────────────────

export async function resetAllData(): Promise<void> {
  await clearAllOrders();
  await clearBalanceSnapshots();
  await clearActivityLog();
  console.log("🗑️ All data cleared");
}

// ─── Export for debugging ─────────────────────────────────────────

export async function exportAllData(): Promise<any> {
  const orders = await getAllOrders();
  const snapshots = await getBalanceSnapshots(1000);
  const activities = await getActivityLog(1000);
  const summaries = await getTradeSummaries(365);
  
  return {
    exportedAt: new Date().toISOString(),
    orders,
    balanceSnapshots: snapshots,
    activityLog: activities,
    tradeSummaries: summaries,
  };
}
