import type { CustomFieldDefinitionRow } from '@/lib/database.types'

/**
 * Finding a company's own fields by name.
 *
 * Region and size are custom fields rather than columns — an organization
 * defines them, names them, and can rename them — so a list column that wants
 * to show one has to go looking. There is no id to hold on to that would
 * survive an admin deleting the field and making it again.
 *
 * Exact first, then a contained word, so "Size" wins over "Company size" when
 * both exist and "Company size" still fills the column when it is the only one.
 * Anything looser would start matching fields that merely mention the word.
 */
export function findCompanyField(
  definitions: CustomFieldDefinitionRow[],
  ...names: string[]
): CustomFieldDefinitionRow | undefined {
  const company = definitions.filter((field) => field.entity_type === 'company')
  const wanted = names.map((name) => name.toLowerCase())

  const exact = company.find(
    (field) =>
      wanted.includes(field.label.trim().toLowerCase()) ||
      wanted.includes(field.key.trim().toLowerCase()),
  )
  if (exact) return exact

  // A word rather than a substring: "size" should not answer to "sizing chart",
  // and splitting on non-letters catches company_size, "Company size" and
  // "Size (band)" alike.
  const words = (value: string) => value.toLowerCase().split(/[^a-z]+/i).filter(Boolean)

  return company.find(
    (field) =>
      words(field.label).some((word) => wanted.includes(word)) ||
      words(field.key).some((word) => wanted.includes(word)),
  )
}

/**
 * What a company holds for one of those fields, as a list.
 *
 * A single-select stores a string and a multi-select an array; the callers all
 * want to render the same way, so both arrive here as a list.
 */
export function companyFieldValues(
  company: { custom_fields?: Record<string, unknown> | null } | null | undefined,
  field: CustomFieldDefinitionRow | undefined,
): string[] {
  if (!company || !field) return []

  const raw = (company.custom_fields ?? {})[field.key]
  if (raw === undefined || raw === null || raw === '') return []

  return Array.isArray(raw) ? raw.map(String) : [String(raw)]
}
