import { Skeleton, StatGridSkeleton, TableSkeleton } from '@/components/ui'

/*
 * One boundary for the whole app group.
 *
 * Its real job is not the skeleton but the Suspense boundary Next.js builds
 * around it: the sidebar and header live in the layout, so they now paint as
 * soon as the session resolves instead of waiting on whatever the page happens
 * to query. Placeholders rather than the word "Loading", so the page does not
 * flash text that is immediately replaced by a different title.
 */
export default function AppLoading() {
  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <StatGridSkeleton />
      <TableSkeleton />
    </>
  )
}
