import { requireAdmin, scoped } from '@/lib/tenancy'
import type { PipelineRow, StageRow } from '@/lib/database.types'
import { PageHeader, Section } from '@/components/ui'
import { ActionForm, SubmitButton } from '@/components/action-form'

import {
  createPipeline,
  createStage,
  movePipeline,
  moveStage,
  renamePipeline,
  restorePipeline,
  restoreStage,
  retirePipeline,
  retireStage,
  setDefaultPipeline,
  updateStage,
} from '../actions'

export const metadata = { title: 'Pipelines · FLO CRM' }

/**
 * One nudge up or down the list.
 *
 * Disabled at the ends rather than hidden, so the row does not change width as
 * a stage travels and the buttons stay where the eye left them. The action is
 * a prop because stages and pipelines are reordered the same way, by different
 * functions.
 */
function MoveButton({
  action,
  id,
  direction,
  disabled,
  label,
}: {
  action: (formData: FormData) => Promise<void>
  id: string
  direction: 'up' | 'down'
  disabled: boolean
  label: string
}) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="direction" value={direction} />
      <button
        type="submit"
        disabled={disabled}
        aria-label={label}
        title={label}
        className="block px-1 text-xs leading-4 text-slate-400 hover:text-brand-700 disabled:cursor-default disabled:text-slate-200 disabled:hover:text-slate-200"
      >
        {direction === 'up' ? '▲' : '▼'}
      </button>
    </form>
  )
}

export default async function PipelineSettingsPage() {
  const context = await requireAdmin()

  const [{ data: pipelines }, { data: stages }, { data: usage }] = await Promise.all([
    scoped(context, 'pipelines').select('*').order('order'),
    scoped(context, 'stages').select('*').order('order'),
    context.supabase.rpc('pipeline_usage'),
  ])

  const allPipelines = (pipelines ?? []) as PipelineRow[]
  const stageList = (stages ?? []) as StageRow[]

  const pipelineList = allPipelines.filter((pipeline) => pipeline.archived_at === null)
  const archivedPipelines = allPipelines.filter((pipeline) => pipeline.archived_at !== null)

  type Usage = { pipeline_id: string; open_deals: number; closed: number; binned: number }

  // A pipeline with no stages at all gets no row back, so read through a map
  // rather than assuming one is there.
  const deals = new Map<string, Usage>(
    ((usage ?? []) as Usage[]).map((row) => [row.pipeline_id, row]),
  )

  return (
    <>
      <PageHeader title="Pipelines & stages" />

      <ActionForm action={createPipeline} className="card mb-5 flex flex-wrap items-end gap-2 p-4">
        <div>
          <label className="label" htmlFor="pipeline-name">
            New pipeline
          </label>
          <input id="pipeline-name" name="name" required className="input w-64" placeholder="Trading desk" />
        </div>
        <SubmitButton className="btn-primary" pendingLabel="Adding…">
          Add pipeline
        </SubmitButton>
      </ActionForm>

      <div className="space-y-5">
        {pipelineList.map((pipeline, pipelineIndex) => {
          const allStages = stageList.filter((stage) => stage.pipeline_id === pipeline.id)
          const pipelineStages = allStages.filter((stage) => stage.archived_at === null)
          const archivedStages = allStages.filter((stage) => stage.archived_at !== null)
          const counts = deals.get(pipeline.id)

          return (
            <Section
              key={pipeline.id}
              title={pipeline.name}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {/*
                    Where this pipeline sits in the bar above the deals board.
                    Up and down rather than left and right, because the list
                    here runs vertically even though the bar does not.
                  */}
                  {pipelineList.length > 1 && (
                    <div className="flex flex-col">
                      <MoveButton
                        action={movePipeline}
                        id={pipeline.id}
                        direction="up"
                        disabled={pipelineIndex === 0}
                        label={`Move ${pipeline.name} earlier`}
                      />
                      <MoveButton
                        action={movePipeline}
                        id={pipeline.id}
                        direction="down"
                        disabled={pipelineIndex === pipelineList.length - 1}
                        label={`Move ${pipeline.name} later`}
                      />
                    </div>
                  )}

                  {/*
                    The heading keeps showing the current name; this renames it.
                    Same shape as the stage rows below — a field with its value
                    in it and a Save beside it — rather than a separate mode.
                  */}
                  <ActionForm action={renamePipeline} className="flex items-center gap-1.5">
                    <input type="hidden" name="id" value={pipeline.id} />
                    <label className="sr-only" htmlFor={`pipeline-name-${pipeline.id}`}>
                      Name for {pipeline.name}
                    </label>
                    <input
                      id={`pipeline-name-${pipeline.id}`}
                      name="name"
                      defaultValue={pipeline.name}
                      required
                      maxLength={120}
                      className="input w-44 py-1 text-xs"
                    />
                    <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" pendingLabel="Saving…">
                      Rename
                    </SubmitButton>
                  </ActionForm>

                  {pipeline.is_default ? (
                    <span className="badge bg-brand-50 text-brand-700">default</span>
                  ) : (
                    <form action={setDefaultPipeline}>
                      <input type="hidden" name="id" value={pipeline.id} />
                      <button type="submit" className="text-xs text-slate-500 hover:text-brand-700">
                        Make default
                      </button>
                    </form>
                  )}

                  {/*
                    What is in it, said before anybody presses Delete rather
                    than after. Deals on the board are what stops it going;
                    deals in the recycle bin are what turn Delete into Archive.
                  */}
                  {counts && (counts.open_deals > 0 || counts.closed > 0) && (
                    <span className="text-xs text-slate-500">
                      {counts.open_deals > 0 && `${counts.open_deals} open`}
                      {counts.open_deals > 0 && counts.closed > 0 && ' · '}
                      {counts.closed > 0 && `${counts.closed} closed`}
                    </span>
                  )}

                  <ActionForm action={retirePipeline}>
                    <input type="hidden" name="id" value={pipeline.id} />
                    <input type="hidden" name="name" value={pipeline.name} />
                    <SubmitButton
                      className="text-xs text-slate-400 hover:text-red-600 disabled:text-slate-300"
                      pendingLabel="…"
                    >
                      Delete
                    </SubmitButton>
                  </ActionForm>
                </div>
              }
            >
              <table className="table mb-3">
                <thead>
                  <tr>
                    <th className="w-28">Position</th>
                    <th>Stage</th>
                    <th className="w-40">Default probability</th>
                    <th className="w-32" />
                  </tr>
                </thead>
                <tbody>
                  {pipelineStages.map((stage, index) => {
                    // The arrows sit in their own forms — a form cannot nest —
                    // and join the row visually rather than structurally.
                    const first = index === 0
                    const last = index === pipelineStages.length - 1

                    return (
                      <tr key={stage.id}>
                        <td colSpan={4} className="p-0">
                          <div className="flex items-center gap-2 px-3 py-2">
                            <div className="flex shrink-0 flex-col">
                              <MoveButton
                                action={moveStage}
                                id={stage.id}
                                direction="up"
                                disabled={first}
                                label={`Move ${stage.name} up`}
                              />
                              <MoveButton
                                action={moveStage}
                                id={stage.id}
                                direction="down"
                                disabled={last}
                                label={`Move ${stage.name} down`}
                              />
                            </div>

                            <ActionForm
                              action={updateStage}
                              className="flex flex-1 items-center gap-2"
                              id={`stage-${stage.id}`}
                            >
                              <input type="hidden" name="id" value={stage.id} />
                              <input
                                name="order"
                                type="number"
                                min="0"
                                defaultValue={stage.order}
                                className="input w-16"
                                aria-label={`Position of ${stage.name}`}
                              />
                              <input
                                name="name"
                                required
                                defaultValue={stage.name}
                                className="input flex-1"
                                aria-label="Stage name"
                              />
                              <div className="flex items-center gap-1">
                                <input
                                  name="default_probability"
                                  type="number"
                                  min="0"
                                  max="100"
                                  defaultValue={Math.round(stage.default_probability * 100)}
                                  className="input w-24"
                                  aria-label="Default probability"
                                />
                                <span className="text-sm text-slate-500">%</span>
                              </div>

                              {/*
                                What landing here means. Dragging a deal into a
                                stage marked won closes it as won — stamps the
                                close date, credits the owner, releases the
                                stock it was holding.

                                Here because the migration that added it said
                                the guessed values would be "visible and can be
                                corrected in Settings", and until now they were
                                neither. A stage called "Closed — Won", or one
                                written in French, has always needed somebody to
                                say so.
                              */}
                              <select
                                name="outcome"
                                defaultValue={stage.outcome}
                                className="input w-32"
                                aria-label={`What reaching ${stage.name} means`}
                              >
                                <option value="open">Still open</option>
                                <option value="won">Closes as won</option>
                                <option value="lost">Closes as lost</option>
                              </select>
                              <SubmitButton className="btn-secondary" pendingLabel="Saving…">
                                Save
                              </SubmitButton>
                            </ActionForm>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              <div className="flex flex-wrap items-center gap-3">
                <ActionForm action={createStage} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="pipeline_id" value={pipeline.id} />
                  <input name="name" required className="input w-52" placeholder="New stage name" />
                  <div className="flex items-center gap-1">
                    <input
                      name="default_probability"
                      type="number"
                      min="0"
                      max="100"
                      defaultValue={50}
                      className="input w-20"
                      aria-label="Default probability"
                    />
                    <span className="text-sm text-slate-500">%</span>
                  </div>
                  <SubmitButton className="btn-secondary" pendingLabel="Adding…">
                    Add stage
                  </SubmitButton>
                </ActionForm>

                {pipelineStages.length > 0 && (
                  <ActionForm action={retireStage} className="flex items-end gap-2">
                    <select name="id" className="input w-52" aria-label="Stage to delete">
                      {pipelineStages.map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.name}
                        </option>
                      ))}
                    </select>
                    <SubmitButton className="btn-danger" pendingLabel="Working…">
                      Delete stage
                    </SubmitButton>
                  </ActionForm>
                )}
              </div>

              {/*
                Stages that had to be archived rather than deleted, because
                deals passed through them and that record is worth more than a
                tidy list. They draw no column and appear in no picker.
              */}
              {archivedStages.length > 0 && (
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <p className="mb-2 text-xs font-medium text-slate-500">Archived stages</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {archivedStages.map((stage) => (
                      <ActionForm
                        key={stage.id}
                        action={restoreStage}
                        className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1"
                      >
                        <input type="hidden" name="id" value={stage.id} />
                        <span className="text-xs text-slate-500">{stage.name}</span>
                        <SubmitButton className="text-xs text-brand-700 hover:underline">
                          Restore
                        </SubmitButton>
                      </ActionForm>
                    ))}
                  </div>
                </div>
              )}
            </Section>
          )
        })}
      </div>

      {/*
        Archived pipelines, kept for their history rather than their use. No
        stage editor: there is nothing to arrange in a pipeline nobody can put a
        deal into. Restore it and it comes back with the stages that went down
        with it.
      */}
      {archivedPipelines.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-1 text-sm font-semibold text-slate-700">Archived pipelines</h2>
          <p className="mb-3 text-xs text-slate-500">
            Off the board and out of every picker. They keep the stage history of the deals that
            passed through them, which is why they were archived instead of deleted.
          </p>
          <div className="space-y-2">
            {archivedPipelines.map((pipeline) => {
              const counts = deals.get(pipeline.id)

              return (
                <div
                  key={pipeline.id}
                  className="card flex flex-wrap items-center justify-between gap-2 px-4 py-2"
                >
                  <div>
                    <span className="text-sm text-slate-600">{pipeline.name}</span>
                    {counts && counts.binned > 0 && (
                      <span className="ml-2 text-xs text-slate-400">
                        {counts.binned} in the recycle bin
                      </span>
                    )}
                  </div>
                  <ActionForm action={restorePipeline}>
                    <input type="hidden" name="id" value={pipeline.id} />
                    <SubmitButton className="btn-secondary px-2.5 py-1 text-xs">
                      Restore
                    </SubmitButton>
                  </ActionForm>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
