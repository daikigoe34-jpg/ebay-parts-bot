CREATE TABLE workspace_documents (
  user_key TEXT NOT NULL,
  namespace TEXT NOT NULL CHECK (namespace IN ('main', 'shipping', 'queue')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_key, namespace)
);
