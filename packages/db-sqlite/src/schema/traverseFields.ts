/* eslint-disable no-param-reassign */
import type { Relation } from 'drizzle-orm'
import type { IndexBuilder, SQLiteColumnBuilder, UniqueConstraintBuilder } from 'drizzle-orm/sqlite-core'
import type { Field, TabAsField } from 'payload/types'

import { relations } from 'drizzle-orm'
import { SQLiteNumericBuilder, SQLiteTextBuilder, index, integer, numeric, text, unique } from 'drizzle-orm/sqlite-core'
import { InvalidConfiguration } from 'payload/errors'
import { fieldAffectsData, optionIsObject } from 'payload/types'
import toSnakeCase from 'to-snake-case'

import type { GenericColumns, SQLiteAdapter } from '../types'

import { hasLocalesTable } from '../utilities/hasLocalesTable'
import { buildTable } from './build'
import { createIndex } from './createIndex'
import { parentIDColumnMap } from './parentIDColumnMap'
import { validateExistingBlockIsIdentical } from './validateExistingBlockIsIdentical'

type Args = {
  adapter: SQLiteAdapter
  buildRelationships: boolean
  columnPrefix?: string
  columns: Record<string, SQLiteColumnBuilder>
  disableUnique?: boolean
  fieldPrefix?: string
  fields: (Field | TabAsField)[]
  forceLocalized?: boolean
  indexes: Record<string, (cols: GenericColumns) => IndexBuilder>
  localesColumns: Record<string, SQLiteColumnBuilder>
  localesIndexes: Record<string, (cols: GenericColumns) => IndexBuilder>
  newTableName: string
  parentTableName: string
  relationsToBuild: Map<string, string>
  relationships: Set<string>
  rootRelationsToBuild?: Map<string, string>
  rootTableIDColType: string
  rootTableName: string
}

type Result = {
  hasLocalizedField: boolean
  hasLocalizedManyNumberField: boolean
  hasLocalizedRelationshipField: boolean
  hasManyNumberField: 'index' | boolean
}

export const traverseFields = ({
  adapter,
  buildRelationships,
  columnPrefix,
  columns,
  disableUnique = false,
  fieldPrefix,
  fields,
  forceLocalized,
  indexes,
  localesColumns,
  localesIndexes,
  newTableName,
  parentTableName,
  relationsToBuild,
  relationships,
  rootRelationsToBuild,
  rootTableIDColType,
  rootTableName,
}: Args): Result => {
  let hasLocalizedField = false
  let hasLocalizedRelationshipField = false
  let hasManyNumberField: 'index' | boolean = false
  let hasLocalizedManyNumberField = false

  let parentIDColType = 'integer'
  if (columns.id instanceof SQLiteNumericBuilder) parentIDColType = 'numeric'
  if (columns.id instanceof SQLiteTextBuilder) parentIDColType = 'text'

  fields.forEach((field) => {
    if ('name' in field && field.name === 'id') return
    let columnName: string
    let fieldName: string

    let targetTable = columns
    let targetIndexes = indexes

    if (fieldAffectsData(field)) {
      columnName = `${columnPrefix || ''}${field.name[0] === '_' ? '_' : ''}${toSnakeCase(
        field.name,
      )}`
      fieldName = `${fieldPrefix || ''}${field.name}`

      // If field is localized,
      // add the column to the locale table instead of main table
      if (adapter.payload.config.localization && (field.localized || forceLocalized)) {
        hasLocalizedField = true
        targetTable = localesColumns
        targetIndexes = localesIndexes
      }

      if (
        (field.unique || field.index) &&
        !['array', 'blocks', 'group', 'point', 'relationship', 'upload'].includes(field.type) &&
        !(field.type === 'number' && field.hasMany === true)
      ) {
        targetIndexes[`${field.name}Idx`] = createIndex({
          name: fieldName,
          columnName,
          unique: disableUnique !== true && field.unique,
        })
      }
    }

    switch (field.type) {
      case 'text':
      case 'email':
      case 'code':
      case 'textarea': {
        targetTable[fieldName] = text(columnName)
        break
      }

      case 'number': {
        if (field.hasMany) {
          if (field.localized) {
            hasLocalizedManyNumberField = true
          }

          if (field.index) {
            hasManyNumberField = 'index'
          } else if (!hasManyNumberField) {
            hasManyNumberField = true
          }

          if (field.unique) {
            throw new InvalidConfiguration(
              'Unique is not supported in Postgres for hasMany number fields.',
            )
          }
        } else {
          targetTable[fieldName] = numeric(columnName)
        }
        break
      }

      case 'richText':
      case 'json': {
        targetTable[fieldName] = text(columnName, { mode: 'json' })
        break
      }

      case 'date': {
        targetTable[fieldName] = text(columnName)
        break
      }

      case 'point': {
        break
      }

      case 'radio':
      case 'select': {
        const enumName = `enum_${newTableName}_${columnPrefix || ''}${toSnakeCase(field.name)}`

        adapter.enums[enumName] =
          field.options.map((option) => {
            if (optionIsObject(option)) {
              return option.value
            }

            return option
          }) as [string, ...string[]]

        if (field.type === 'select' && field.hasMany) {
          const baseColumns: Record<string, SQLiteColumnBuilder> = {
            order: integer('order').notNull(),
            parent: parentIDColumnMap[parentIDColType]('parent_id')
              .references(() => adapter.tables[parentTableName].id, { onDelete: 'cascade' })
              .notNull(),
            value: text('value', { enum: adapter.enums[enumName] })
          }

          const baseExtraConfig: Record<
            string,
            (cols: GenericColumns) => IndexBuilder | UniqueConstraintBuilder
          > = {}

          if (field.localized) {
            baseColumns.locale = text('locale', { enum: adapter.enums.enum__locales }).notNull()
            baseExtraConfig.parentOrderLocale = (cols) =>
              unique().on(cols.parent, cols.order, cols.locale)
          } else {
            baseExtraConfig.parent = (cols) => index('parent_idx').on(cols.parent)
            baseExtraConfig.order = (cols) => index('order_idx').on(cols.order)
          }

          if (field.index) {
            baseExtraConfig.value = (cols) => index('value_idx').on(cols.value)
          }

          const selectTableName = `${newTableName}_${toSnakeCase(fieldName)}`

          buildTable({
            adapter,
            baseColumns,
            baseExtraConfig,
            disableUnique,
            fields: [],
            tableName: selectTableName,
          })

          relationsToBuild.set(fieldName, selectTableName)

          const selectTableRelations = relations(adapter.tables[selectTableName], ({ one }) => {
            const result: Record<string, Relation<string>> = {
              parent: one(adapter.tables[parentTableName], {
                fields: [adapter.tables[selectTableName].parent],
                references: [adapter.tables[parentTableName].id],
              }),
            }

            return result
          })

          adapter.relations[`relation_${selectTableName}`] = selectTableRelations
        } else {
          targetTable[fieldName] = text(fieldName, { enum: adapter.enums[enumName] })
        }
        break
      }

      case 'checkbox': {
        targetTable[fieldName] = integer(columnName, { mode: 'boolean' })
        break
      }

      case 'array': {
        const baseColumns: Record<string, SQLiteColumnBuilder> = {
          _order: integer('_order').notNull(),
          _parentID: parentIDColumnMap[parentIDColType]('_parent_id')
            .references(() => adapter.tables[parentTableName].id, { onDelete: 'cascade' })
            .notNull(),
        }

        const baseExtraConfig: Record<
          string,
          (cols: GenericColumns) => IndexBuilder | UniqueConstraintBuilder
        > = {}

        if (field.localized && adapter.payload.config.localization) {
          baseColumns._locale = text('locale', { enum: adapter.enums.enum__locales }).notNull()
          baseExtraConfig._parentOrderLocale = (cols) =>
            unique().on(cols._parentID, cols._order, cols._locale)
        } else {
          baseExtraConfig._parentOrder = (cols) => unique().on(cols._parentID, cols._order)
        }

        const arrayTableName = `${newTableName}_${toSnakeCase(field.name)}`

        const { relationsToBuild: subRelationsToBuild } = buildTable({
          adapter,
          baseColumns,
          baseExtraConfig,
          disableUnique,
          fields: field.fields,
          rootRelationsToBuild,
          rootTableIDColType,
          rootTableName,
          tableName: arrayTableName,
        })

        relationsToBuild.set(fieldName, arrayTableName)

        const arrayTableRelations = relations(adapter.tables[arrayTableName], ({ many, one }) => {
          const result: Record<string, Relation<string>> = {
            _parentID: one(adapter.tables[parentTableName], {
              fields: [adapter.tables[arrayTableName]._parentID],
              references: [adapter.tables[parentTableName].id],
            }),
          }

          if (hasLocalesTable(field.fields)) {
            result._locales = many(adapter.tables[`${arrayTableName}_locales`])
          }

          subRelationsToBuild.forEach((val, key) => {
            result[key] = many(adapter.tables[val])
          })

          return result
        })

        adapter.relations[`relations_${arrayTableName}`] = arrayTableRelations

        break
      }

      case 'blocks': {
        field.blocks.forEach((block) => {
          const blockTableName = `${rootTableName}_blocks_${toSnakeCase(block.slug)}`
          if (!adapter.tables[blockTableName]) {
            const baseColumns: Record<string, SQLiteColumnBuilder> = {
              _order: integer('_order').notNull(),
              _parentID: parentIDColumnMap[rootTableIDColType]('_parent_id')
                .references(() => adapter.tables[rootTableName].id, { onDelete: 'cascade' })
                .notNull(),
              _path: text('_path').notNull(),
            }

            const baseExtraConfig: Record<
              string,
              (cols: GenericColumns) => IndexBuilder | UniqueConstraintBuilder
            > = {}

            if (field.localized && adapter.payload.config.localization) {
              baseColumns._locale = text('locale', { enum: adapter.enums.enum__locales }).notNull()
              baseExtraConfig._parentPathOrderLocale = (cols) =>
                unique().on(cols._parentID, cols._path, cols._order, cols._locale)
            } else {
              baseExtraConfig._parentPathOrder = (cols) =>
                unique().on(cols._parentID, cols._path, cols._order)
            }

            const { relationsToBuild: subRelationsToBuild } = buildTable({
              adapter,
              baseColumns,
              baseExtraConfig,
              disableUnique,
              fields: block.fields,
              rootRelationsToBuild,
              rootTableIDColType,
              rootTableName,
              tableName: blockTableName,
            })

            const blockTableRelations = relations(
              adapter.tables[blockTableName],
              ({ many, one }) => {
                const result: Record<string, Relation<string>> = {
                  _parentID: one(adapter.tables[rootTableName], {
                    fields: [adapter.tables[blockTableName]._parentID],
                    references: [adapter.tables[rootTableName].id],
                  }),
                }

                if (hasLocalesTable(block.fields)) {
                  result._locales = many(adapter.tables[`${blockTableName}_locales`])
                }

                subRelationsToBuild.forEach((val, key) => {
                  result[key] = many(adapter.tables[val])
                })

                return result
              },
            )

            adapter.relations[`relations_${blockTableName}`] = blockTableRelations
          } else if (process.env.NODE_ENV !== 'production') {
            validateExistingBlockIsIdentical({
              block,
              localized: field.localized,
              rootTableName,
              table: adapter.tables[blockTableName],
            })
          }

          rootRelationsToBuild.set(`_blocks_${block.slug}`, blockTableName)
        })

        break
      }

      case 'tab':
      case 'group': {
        if (!('name' in field)) {
          const {
            hasLocalizedField: groupHasLocalizedField,
            hasLocalizedManyNumberField: groupHasLocalizedManyNumberField,
            hasLocalizedRelationshipField: groupHasLocalizedRelationshipField,
            hasManyNumberField: groupHasManyNumberField,
          } = traverseFields({
            adapter,
            buildRelationships,
            columnPrefix,
            columns,
            disableUnique,
            fieldPrefix,
            fields: field.fields,
            forceLocalized,
            indexes,
            localesColumns,
            localesIndexes,
            newTableName: parentTableName,
            parentTableName,
            relationsToBuild,
            relationships,
            rootRelationsToBuild,
            rootTableIDColType,
            rootTableName,
          })

          if (groupHasLocalizedField) hasLocalizedField = true
          if (groupHasLocalizedRelationshipField) hasLocalizedRelationshipField = true
          if (groupHasManyNumberField) hasManyNumberField = true
          if (groupHasLocalizedManyNumberField) hasLocalizedManyNumberField = true
          break
        }

        const {
          hasLocalizedField: groupHasLocalizedField,
          hasLocalizedManyNumberField: groupHasLocalizedManyNumberField,
          hasLocalizedRelationshipField: groupHasLocalizedRelationshipField,
          hasManyNumberField: groupHasManyNumberField,
        } = traverseFields({
          adapter,
          buildRelationships,
          columnPrefix: `${columnName}_`,
          columns,
          disableUnique,
          fieldPrefix: `${fieldName}_`,
          fields: field.fields,
          forceLocalized: field.localized,
          indexes,
          localesColumns,
          localesIndexes,
          newTableName: `${parentTableName}_${columnName}`,
          parentTableName,
          relationsToBuild,
          relationships,
          rootRelationsToBuild,
          rootTableIDColType,
          rootTableName,
        })

        if (groupHasLocalizedField) hasLocalizedField = true
        if (groupHasLocalizedRelationshipField) hasLocalizedRelationshipField = true
        if (groupHasManyNumberField) hasManyNumberField = true
        if (groupHasLocalizedManyNumberField) hasLocalizedManyNumberField = true
        break
      }

      case 'tabs': {
        const {
          hasLocalizedField: tabHasLocalizedField,
          hasLocalizedManyNumberField: tabHasLocalizedManyNumberField,
          hasLocalizedRelationshipField: tabHasLocalizedRelationshipField,
          hasManyNumberField: tabHasManyNumberField,
        } = traverseFields({
          adapter,
          buildRelationships,
          columnPrefix,
          columns,
          disableUnique,
          fieldPrefix,
          fields: field.tabs.map((tab) => ({ ...tab, type: 'tab' })),
          forceLocalized,
          indexes,
          localesColumns,
          localesIndexes,
          newTableName,
          parentTableName,
          relationsToBuild,
          relationships,
          rootRelationsToBuild,
          rootTableIDColType,
          rootTableName,
        })

        if (tabHasLocalizedField) hasLocalizedField = true
        if (tabHasLocalizedRelationshipField) hasLocalizedRelationshipField = true
        if (tabHasManyNumberField) hasManyNumberField = true
        if (tabHasLocalizedManyNumberField) hasLocalizedManyNumberField = true

        break
      }

      case 'row':
      case 'collapsible': {
        const {
          hasLocalizedField: rowHasLocalizedField,
          hasLocalizedManyNumberField: rowHasLocalizedManyNumberField,
          hasLocalizedRelationshipField: rowHasLocalizedRelationshipField,
          hasManyNumberField: rowHasManyNumberField,
        } = traverseFields({
          adapter,
          buildRelationships,
          columnPrefix,
          columns,
          disableUnique,
          fieldPrefix,
          fields: field.fields,
          forceLocalized,
          indexes,
          localesColumns,
          localesIndexes,
          newTableName: parentTableName,
          parentTableName,
          relationsToBuild,
          relationships,
          rootRelationsToBuild,
          rootTableIDColType,
          rootTableName,
        })

        if (rowHasLocalizedField) hasLocalizedField = true
        if (rowHasLocalizedRelationshipField) hasLocalizedRelationshipField = true
        if (rowHasManyNumberField) hasManyNumberField = true
        if (rowHasLocalizedManyNumberField) hasLocalizedManyNumberField = true
        break
      }

      case 'relationship':
      case 'upload':
        if (Array.isArray(field.relationTo)) {
          field.relationTo.forEach((relation) => relationships.add(relation))
        } else {
          relationships.add(field.relationTo)
        }

        if (field.localized && adapter.payload.config.localization) {
          hasLocalizedRelationshipField = true
        }
        break

      default:
        break
    }

    const condition = field.admin && field.admin.condition

    if (targetTable[fieldName] && 'required' in field && field.required && !condition) {
      targetTable[fieldName].notNull()
    }
  })

  return {
    hasLocalizedField,
    hasLocalizedManyNumberField,
    hasLocalizedRelationshipField,
    hasManyNumberField,
  }
}