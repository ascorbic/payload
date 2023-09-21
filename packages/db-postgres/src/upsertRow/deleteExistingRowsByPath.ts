import { and, eq, inArray } from 'drizzle-orm'

import type { DrizzleDB, PostgresAdapter } from '../types'

type Args = {
  adapter: PostgresAdapter
  db: DrizzleDB
  localeColumnName?: string
  newRows: Record<string, unknown>[]
  parentColumnName?: string
  parentID: unknown
  pathColumnName?: string
  tableName: string
}

export const deleteExistingRowsByPath = async ({
  adapter,
  db,
  localeColumnName = '_locale',
  newRows,
  parentColumnName = '_parentID',
  parentID,
  pathColumnName = '_path',
  tableName,
}: Args): Promise<void> => {
  const localizedPathsToDelete = new Set<string>()
  const pathsToDelete = new Set<string>()
  const table = adapter.tables[tableName]

  newRows.forEach((row) => {
    const path = row[pathColumnName]
    const localeData = row[localeColumnName]
    if (typeof path === 'string') {
      if (typeof localeData === 'string') {
        localizedPathsToDelete.add(path)
      } else {
        pathsToDelete.add(path)
      }
    }
  })

  if (localizedPathsToDelete.size > 0) {
    const whereConstraints = [eq(table[parentColumnName], parentID)]

    if (pathColumnName)
      whereConstraints.push(inArray(table[pathColumnName], Array.from(localizedPathsToDelete)))

    await db.delete(table).where(and(...whereConstraints))
  }

  if (pathsToDelete.size > 0) {
    const whereConstraints = [eq(table[parentColumnName], parentID)]

    if (pathColumnName)
      whereConstraints.push(inArray(table[pathColumnName], Array.from(pathsToDelete)))

    await db.delete(table).where(and(...whereConstraints))
  }
}
