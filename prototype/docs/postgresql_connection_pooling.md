# PostgreSQL Connection Pooling and Connection Exhaustion

## Overview
PostgreSQL has a hard limit on simultaneous connections (`max_connections`, default 100). When this limit is reached, new connection attempts are rejected with "remaining connection slots are reserved for non-replication superuser connections". Each idle connection still consumes ~5-10MB of memory.

## Diagnosing Connection Exhaustion

```sql
-- View current connection counts by state
SELECT state, count(*) 
FROM pg_stat_activity 
GROUP BY state;

-- Find long-running idle transactions
SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '5 minutes'
ORDER BY duration DESC;

-- View connection limits
SHOW max_connections;

-- Check connection usage
SELECT count(*) FROM pg_stat_activity;
```

## Immediate Mitigation
```sql
-- Terminate idle connections (not in a transaction)
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle'
  AND state_change < NOW() - INTERVAL '10 minutes';

-- Kill specific long-running query
SELECT pg_cancel_backend(<pid>);
SELECT pg_terminate_backend(<pid>);
```

## PgBouncer Connection Pooler

PgBouncer sits between the application and PostgreSQL, multiplexing thousands of application connections onto a small pool of real database connections.

### Pooling modes
- **Session pooling**: One server connection per client session (least efficient)
- **Transaction pooling**: Server connection held only during a transaction (recommended for most apps)
- **Statement pooling**: Connection released after each statement (most aggressive)

### PgBouncer configuration (`pgbouncer.ini`)
```ini
[databases]
mydb = host=127.0.0.1 port=5432 dbname=mydb

[pgbouncer]
pool_mode = transaction
max_client_conn = 10000
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3
server_idle_timeout = 600
```

### Recommended pool_size formula
```
pool_size = CPU_cores * 2 + effective_spindles
```
For a 4-core RDS instance with SSD: pool_size = 4 * 2 + 1 = 9 (round up to 10-20 for safety).

## PostgreSQL Tuning

### Prevent connection leaks
```sql
-- Set session-level timeout for idle transactions
ALTER SYSTEM SET idle_in_transaction_session_timeout = '5min';
ALTER SYSTEM SET statement_timeout = '30s';
SELECT pg_reload_conf();
```

### Increase max_connections (with caution)
Each additional connection uses ~5-10MB RAM. Increasing `max_connections` requires a PostgreSQL restart.
```sql
ALTER SYSTEM SET max_connections = 200;
-- Restart required
```

## Scaling Strategies
1. **Read replicas**: Route SELECT queries to read replicas to reduce load on primary.
2. **Vertical scaling**: Increase database instance size for more RAM and CPU.
3. **Query optimization**: Reduce connection hold time by optimizing slow queries (`EXPLAIN ANALYZE`).
4. **Connection validation**: Enable `tcp_keepalives_idle` to detect stale connections.

## Prevention
- Monitor `pg_stat_activity` connection count. Alert when > 80% of `max_connections`.
- Use `pgbouncer` from day one, even in development.
- Set `idle_in_transaction_session_timeout` to prevent connection leaks.
- Implement connection health checks in application connection pools.
