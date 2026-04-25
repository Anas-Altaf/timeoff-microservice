import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ALL_ENTITIES } from './entities';
import { InitialSchema1700000000001 } from './migrations/0001-initial-schema';

/**
 * Production / CLI data source (NFR-15).
 *
 * `synchronize: false` — schema is owned by migrations. The TypeORM CLI
 * picks up this exported `default` for `migration:run` / `migration:revert`.
 *
 * Tests use `synchronize: true` against an in-memory DB (see harness).
 */
export const productionDataSourceOptions: DataSourceOptions = {
  type: 'better-sqlite3',
  database: process.env.DATABASE_PATH ?? 'data/readyon.sqlite',
  entities: ALL_ENTITIES,
  migrations: [InitialSchema1700000000001],
  synchronize: false,
  logging: false,
};

export default new DataSource(productionDataSourceOptions);
