import type {
  SanitizedCollectionConfig,
  SanitizedConfig,
  SanitizedGlobalConfig,
} from 'payload/types'
import type { PaginatedDocs } from 'payload/database'
import type { Version } from '@payloadcms/ui'
import { User } from 'payload/auth'

export type DefaultVersionsViewProps = {
  canAccessAdmin: boolean
  config: SanitizedConfig
  collectionConfig?: SanitizedCollectionConfig
  globalConfig?: SanitizedGlobalConfig
  data: Version
  versionsData: PaginatedDocs<Version>
  editURL: string
  entityLabel: string
  id: string
  user: User
  limit: number
}
