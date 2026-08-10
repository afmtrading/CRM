/**
 * Row shapes for every table in supabase/migrations.
 *
 * These are hand-maintained and used to type query results at the call site
 * (`.maybeSingle<ContactRow>()`, `as ContactRow[]`). The Supabase client itself
 * is deliberately left untyped: a hand-written Database generic cannot describe
 * foreign-key relationships accurately enough for nested selects like
 * `select('*, companies(id, name)')` to resolve, and a wrong generic is worse
 * than none.
 *
 * Once the Supabase project exists, generate the real thing:
 *
 *   supabase gen types typescript --project-id <id> > src/lib/database.generated.ts
 *
 * then pass it to createServerClient/createBrowserClient as the generic and
 * drop the casts. The Database type below is kept in the generator's shape so
 * that swap is mechanical.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type OrgStatus = 'active' | 'inactive'
export type UserRole = 'admin' | 'manager' | 'sales_director' | 'regular' | 'readonly'
export type UserStatus = 'active' | 'invited' | 'disabled'
export type LifecycleStage = 'lead' | 'qualified' | 'customer' | 'other'
export type DealStatus = 'open' | 'won' | 'lost'
export type DealValueSource = 'manual' | 'products'
export type ActivityType = 'call' | 'email' | 'meeting' | 'note' | 'task'
export type RelatedToType = 'contact' | 'company' | 'deal'
export type ImportStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type FilterEntityType = 'contact' | 'company' | 'deal' | 'campaign' | 'product'
export type ScoreCondition =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'is_filled'
  | 'is_empty'
  | 'greater_than'
  | 'less_than'
export type AssignmentStrategy = 'round_robin' | 'by_source' | 'fixed_user'
export type CustomFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect'

/**
 * Which card on a record a field is rendered under. Contacts and companies
 * share the first four; 'pricing' belongs to products alone.
 */
export type ContactCard = 'details' | 'influence' | 'additional' | 'digital' | 'pricing'

/** Palette a select option's colour is drawn from (mapped to classes in lib/field-options.ts). */
export type OptionColor =
  | 'slate'
  | 'blue'
  | 'green'
  | 'amber'
  | 'red'
  | 'violet'
  | 'cyan'
  | 'rose'
  | 'orange'
  | 'teal'

/** The built-in option lists an organization configures for its records. */
export type OptionFieldKey =
  | 'specialty_market'
  | 'customer_type'
  | 'role_type'
  | 'priority'
  | 'credibility'
  | 'product_category'

/** A named link on the Digital card, beyond the known social networks. */
export type ContactLink = { label: string; url: string }

/** A labelled postal address on a company. */
export type CompanyAddress = { label: string; address: string }

type Row<T> = T
type Insert<T, Optional extends keyof T> = Omit<T, Optional> & Partial<Pick<T, Optional>>

export type OrganizationRow = {
  id: string
  name: string
  slug: string
  status: OrgStatus
  logo_url: string | null
  primary_color: string
  default_currency: string
  created_at: string
}

export type UserRow = {
  id: string
  organization_id: string
  email: string
  name: string
  role: UserRole
  auth_provider_id: string | null
  status: UserStatus
  last_login_at: string | null
  created_at: string
}

export type ContactRow = {
  id: string
  organization_id: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  company_id: string | null
  owner_id: string | null
  lifecycle_stage: LifecycleStage
  source: string | null
  custom_fields: Record<string, Json>
  lead_score: number
  duplicate_of_id: string | null
  job_title: string | null
  office_phone: string | null
  role_type: string[]
  priority: string | null
  credibility: string | null
  birthday: string | null
  /** Markdown, rendered through renderMarkdown() — never raw HTML. */
  notes: string | null
  website: string | null
  facebook: string | null
  instagram: string | null
  tiktok: string | null
  x_twitter: string | null
  linkedin: string | null
  links: ContactLink[]
  created_by: string | null
  updated_by: string | null
  /** Soft delete. Only an administrator sees a stamped record. */
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export type FieldOptionRow = {
  id: string
  organization_id: string
  entity_type: FilterEntityType
  /** A built-in OptionFieldKey, or a custom field's own key. */
  field_key: string
  value: string
  color: OptionColor
  order: number
  created_at: string
}

export type CompanyRow = {
  id: string
  organization_id: string
  name: string
  /** The company's website. Surfaced as "Website", kept as `domain` so existing rows and imports still line up. */
  domain: string | null
  /** Superseded by specialty_market; retained so older rows keep their value. */
  industry: string | null
  owner_id: string | null
  custom_fields: Record<string, Json>
  phone: string | null
  email: string | null
  /** Markdown, rendered through renderMarkdown() — never raw HTML. */
  notes: string | null
  specialty_market: string[]
  customer_type: string[]
  linkedin: string | null
  facebook: string | null
  instagram: string | null
  tiktok: string | null
  x_twitter: string | null
  links: ContactLink[]
  addresses: CompanyAddress[]
  created_by: string | null
  updated_by: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

/**
 * A linked mailbox, as the application is allowed to see it.
 *
 * refresh_token is deliberately absent: `authenticated` holds no grant on that
 * column, so a `select('*')` is refused by the database. Select the named
 * columns instead — the type mirrors what is actually readable.
 */
export type MailboxConnectionRow = {
  id: string
  organization_id: string
  user_id: string
  provider: 'gmail'
  email_address: string
  /** Gmail's incremental cursor. Null means the next run backfills. */
  history_id: string | null
  backfill_days: number
  /** How far back the history import has reached. Null = not started. */
  backfill_until: string | null
  status: 'active' | 'needs_reauth' | 'disabled'
  last_error: string | null
  last_synced_at: string | null
  messages_logged: number
  created_at: string
  updated_at: string
}

export type NotificationRow = {
  id: string
  organization_id: string
  user_id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  read_at: string | null
  created_at: string
}

export type CompanyTagRow = {
  organization_id: string
  company_id: string
  tag_id: string
  created_at: string
}

export type PipelineRow = {
  id: string
  organization_id: string
  name: string
  is_default: boolean
  created_at: string
}

export type StageRow = {
  id: string
  organization_id: string
  pipeline_id: string
  name: string
  order: number
  default_probability: number
  created_at: string
}

export type DealRow = {
  id: string
  organization_id: string
  name: string
  contact_id: string | null
  company_id: string | null
  stage_id: string
  value: number
  currency: string
  probability: number
  probability_overridden: boolean
  /**
   * Where `value` comes from. 'products' means it is the sum of the deal's line
   * items and is kept in step automatically; 'manual' means somebody typed it.
   */
  value_source: DealValueSource
  expected_close_date: string | null
  actual_close_date: string | null
  status: DealStatus
  owner_id: string | null
  position: number
  created_at: string
  updated_at: string
}

export type ProductRow = {
  id: string
  organization_id: string
  name: string
  sku: string | null
  /** Drawn from field_options, like every other select field. */
  category: string | null
  /** kg, MT, container, licence — whatever the line item is counted in. */
  unit: string
  unit_price: number
  unit_cost: number
  currency: string
  /** Markdown, rendered through renderMarkdown() — never raw HTML. */
  description: string | null
  custom_fields: Record<string, Json>
  /** Retired but still on old deals. The everyday alternative to deleting. */
  active: boolean
  created_by: string | null
  updated_by: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

/**
 * A product on a deal, at the price it was sold for.
 *
 * unit_price and unit_cost are copied from the product when the line is added
 * and never follow it afterwards, so re-pricing the catalogue cannot rewrite
 * what a closed deal was worth. Amounts are in the deal's currency.
 */
export type DealProductRow = {
  id: string
  organization_id: string
  deal_id: string
  product_id: string
  quantity: number
  unit_price: number
  unit_cost: number
  discount_pct: number
  /** Generated in the database — never written by the application. */
  line_total: number
  line_cost: number
  position: number
  created_at: string
  updated_at: string
}

/** What a contact has asked about. Intent, not purchase history. */
export type ContactProductRow = {
  organization_id: string
  contact_id: string
  product_id: string
  created_at: string
}

export type ActivityRow = {
  id: string
  organization_id: string
  type: ActivityType
  related_to_type: RelatedToType
  related_to_id: string
  owner_id: string | null
  subject: string
  body: string | null
  due_date: string | null
  completed_at: string | null
  external_source: string | null
  external_id: string | null
  occurred_at: string
  created_at: string
}

export type TagRow = {
  id: string
  organization_id: string
  name: string
  color: string
  created_at: string
}

export type ContactTagRow = {
  organization_id: string
  contact_id: string
  tag_id: string
  created_at: string
}

export type SavedFilterRow = {
  id: string
  organization_id: string
  user_id: string | null
  entity_type: FilterEntityType
  name: string
  filter_json: Json
  is_shared: boolean
  created_at: string
}

export type ImportJobRow = {
  id: string
  organization_id: string
  user_id: string | null
  entity_type: FilterEntityType
  status: ImportStatus
  file_name: string
  field_mapping: Json
  options: Json
  rows_processed: number
  rows_failed: number
  errors: Json
  created_at: string
  completed_at: string | null
}

export type LeadScoreRuleRow = {
  id: string
  organization_id: string
  field: string
  condition: ScoreCondition
  value: string | null
  points: number
  is_active: boolean
  created_at: string
}

export type AssignmentRuleRow = {
  id: string
  organization_id: string
  name: string
  strategy: AssignmentStrategy
  source_match: string | null
  fixed_user_id: string | null
  last_assigned_id: string | null
  priority: number
  is_active: boolean
  created_at: string
}

export type CustomFieldDefinitionRow = {
  id: string
  organization_id: string
  entity_type: FilterEntityType
  key: string
  label: string
  field_type: CustomFieldType
  options: Json
  order: number
  card: ContactCard
  created_at: string
}

export type PipelineValueReportRow = {
  stage_id: string
  stage_name: string
  stage_order: number
  pipeline_id: string
  pipeline_name: string
  owner_id: string | null
  owner_name: string | null
  deal_count: number
  total_value: number
  weighted_value: number
}

/** One row per product per currency — currencies are never added together. */
export type ProductMixReportRow = {
  product_id: string
  product_name: string
  category: string | null
  currency: string
  deal_count: number
  total_quantity: number
  total_value: number
  weighted_value: number
  total_cost: number
  margin: number
}

export type DuplicateGroupRow = {
  match_key: string
  match_type: string
  contact_ids: string[]
  contact_count: number
}

type TableDef<TRow, TOptional extends keyof TRow> = {
  Row: Row<TRow>
  Insert: Insert<TRow, TOptional>
  Update: Partial<TRow>
  Relationships: []
}

export interface Database {
  public: {
    Tables: {
      organizations: TableDef<
        OrganizationRow,
        'id' | 'status' | 'logo_url' | 'primary_color' | 'default_currency' | 'created_at'
      >
      users: TableDef<
        UserRow,
        'id' | 'name' | 'role' | 'auth_provider_id' | 'status' | 'last_login_at' | 'created_at'
      >
      contacts: TableDef<
        ContactRow,
        | 'id'
        | 'first_name'
        | 'last_name'
        | 'email'
        | 'phone'
        | 'company_id'
        | 'owner_id'
        | 'lifecycle_stage'
        | 'source'
        | 'custom_fields'
        | 'lead_score'
        | 'duplicate_of_id'
        | 'job_title'
        | 'office_phone'
        | 'role_type'
        | 'priority'
        | 'credibility'
        | 'birthday'
        | 'notes'
        | 'website'
        | 'facebook'
        | 'instagram'
        | 'tiktok'
        | 'x_twitter'
        | 'linkedin'
        | 'links'
        | 'created_by'
        | 'updated_by'
        | 'deleted_at'
        | 'deleted_by'
        | 'created_at'
        | 'updated_at'
      >
      companies: TableDef<
        CompanyRow,
        | 'id'
        | 'domain'
        | 'industry'
        | 'owner_id'
        | 'custom_fields'
        | 'phone'
        | 'email'
        | 'notes'
        | 'specialty_market'
        | 'customer_type'
        | 'linkedin'
        | 'facebook'
        | 'instagram'
        | 'tiktok'
        | 'x_twitter'
        | 'links'
        | 'addresses'
        | 'created_by'
        | 'updated_by'
        | 'deleted_at'
        | 'deleted_by'
        | 'created_at'
        | 'updated_at'
      >
      notifications: TableDef<NotificationRow, 'id' | 'body' | 'link' | 'read_at' | 'created_at'>
      mailbox_connections: TableDef<
        MailboxConnectionRow,
        | 'id'
        | 'provider'
        | 'history_id'
        | 'backfill_days'
        | 'backfill_until'
        | 'status'
        | 'last_error'
        | 'last_synced_at'
        | 'messages_logged'
        | 'created_at'
        | 'updated_at'
      >
      company_tags: TableDef<CompanyTagRow, 'organization_id' | 'created_at'>
      pipelines: TableDef<PipelineRow, 'id' | 'is_default' | 'created_at'>
      stages: TableDef<
        StageRow,
        'id' | 'organization_id' | 'order' | 'default_probability' | 'created_at'
      >
      deals: TableDef<
        DealRow,
        | 'id'
        | 'contact_id'
        | 'company_id'
        | 'value'
        | 'currency'
        | 'probability'
        | 'probability_overridden'
        | 'value_source'
        | 'expected_close_date'
        | 'actual_close_date'
        | 'status'
        | 'owner_id'
        | 'position'
        | 'created_at'
        | 'updated_at'
      >
      activities: TableDef<
        ActivityRow,
        | 'id'
        | 'owner_id'
        | 'subject'
        | 'body'
        | 'due_date'
        | 'completed_at'
        | 'external_source'
        | 'external_id'
        | 'occurred_at'
        | 'created_at'
      >
      products: TableDef<
        ProductRow,
        | 'id'
        | 'sku'
        | 'category'
        | 'unit'
        | 'unit_price'
        | 'unit_cost'
        | 'currency'
        | 'description'
        | 'custom_fields'
        | 'active'
        | 'created_by'
        | 'updated_by'
        | 'deleted_at'
        | 'deleted_by'
        | 'created_at'
        | 'updated_at'
      >
      deal_products: TableDef<
        DealProductRow,
        | 'id'
        | 'quantity'
        | 'unit_price'
        | 'unit_cost'
        | 'discount_pct'
        | 'line_total'
        | 'line_cost'
        | 'position'
        | 'created_at'
        | 'updated_at'
      >
      contact_products: TableDef<ContactProductRow, 'organization_id' | 'created_at'>
      tags: TableDef<TagRow, 'id' | 'color' | 'created_at'>
      contact_tags: TableDef<ContactTagRow, 'organization_id' | 'created_at'>
      saved_filters: TableDef<
        SavedFilterRow,
        'id' | 'user_id' | 'entity_type' | 'filter_json' | 'is_shared' | 'created_at'
      >
      import_jobs: TableDef<
        ImportJobRow,
        | 'id'
        | 'user_id'
        | 'entity_type'
        | 'status'
        | 'file_name'
        | 'field_mapping'
        | 'options'
        | 'rows_processed'
        | 'rows_failed'
        | 'errors'
        | 'created_at'
        | 'completed_at'
      >
      lead_score_rules: TableDef<LeadScoreRuleRow, 'id' | 'value' | 'points' | 'is_active' | 'created_at'>
      assignment_rules: TableDef<
        AssignmentRuleRow,
        | 'id'
        | 'strategy'
        | 'source_match'
        | 'fixed_user_id'
        | 'last_assigned_id'
        | 'priority'
        | 'is_active'
        | 'created_at'
      >
      custom_field_definitions: TableDef<
        CustomFieldDefinitionRow,
        'id' | 'entity_type' | 'field_type' | 'options' | 'order' | 'card' | 'created_at'
      >
      field_options: TableDef<FieldOptionRow, 'id' | 'entity_type' | 'color' | 'order' | 'created_at'>
    }
    Views: Record<string, never>
    Functions: {
      recalculate_lead_scores: { Args: Record<string, never>; Returns: number }
      find_duplicate_contacts: {
        Args: {
          p_email?: string | null
          p_first_name?: string | null
          p_last_name?: string | null
          p_phone?: string | null
          p_exclude_id?: string | null
        }
        Returns: ContactRow[]
      }
      find_duplicate_groups: { Args: Record<string, never>; Returns: DuplicateGroupRow[] }
      merge_contacts: { Args: { p_target_id: string; p_source_id: string }; Returns: ContactRow }
      next_assignee: { Args: { p_source?: string | null }; Returns: string | null }
      report_pipeline_value: {
        Args: { p_pipeline_id?: string | null; p_owner_id?: string | null }
        Returns: PipelineValueReportRow[]
      }
      create_birthday_reminders: { Args: { p_days_ahead?: number }; Returns: number }
      reassign_contact: { Args: { p_contact_id: string; p_new_owner_id: string | null }; Returns: void }
      report_product_mix: {
        Args: { p_pipeline_id?: string | null; p_status?: DealStatus | null }
        Returns: ProductMixReportRow[]
      }
      set_deal_value_from_products: { Args: { p_deal_id: string }; Returns: void }
      soft_delete_product: { Args: { p_product_id: string }; Returns: void }
      restore_product: { Args: { p_product_id: string }; Returns: void }
      soft_delete_contact: { Args: { p_contact_id: string }; Returns: void }
      soft_delete_company: { Args: { p_company_id: string }; Returns: void }
      restore_contact: { Args: { p_contact_id: string }; Returns: void }
      disconnect_mailbox: { Args: { p_connection_id: string }; Returns: void }
      set_mailbox_backfill: { Args: { p_connection_id: string; p_days: number }; Returns: void }
      restore_company: { Args: { p_company_id: string }; Returns: void }
      reassign_deal: { Args: { p_deal_id: string; p_new_owner_id: string | null }; Returns: void }
      can_manage_records: { Args: Record<string, never>; Returns: boolean }
      can_write_records: { Args: Record<string, never>; Returns: boolean }
      current_org_id: { Args: Record<string, never>; Returns: string }
      is_org_admin: { Args: Record<string, never>; Returns: boolean }
    }
    Enums: {
      org_status: OrgStatus
      user_role: UserRole
      user_status: UserStatus
      lifecycle_stage: LifecycleStage
      deal_status: DealStatus
      activity_type: ActivityType
      related_to_type: RelatedToType
      import_status: ImportStatus
      filter_entity_type: FilterEntityType
      score_condition: ScoreCondition
      assignment_strategy: AssignmentStrategy
      custom_field_type: CustomFieldType
    }
    CompositeTypes: Record<string, never>
  }
}
