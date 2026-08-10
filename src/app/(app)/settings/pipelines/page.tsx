import { requireAdmin, scoped } from '@/lib/tenancy'
import type { PipelineRow, StageRow } from '@/lib/database.types'
import { PageHeader, Section } from '@/components/ui'

import {
  createPipeline,
  createStage,
  deletePipeline,
  deleteStage,
  setDefaultPipeline,
  updateStage,
} from '../actions'

export const metadata = { title: 'Pipelines · FLO CRM' }

export default async function PipelineSettingsPage() {
  const context = await requireAdmin()

  const [{ data: pipelines }, { data: stages }] = await Promise.all([
    scoped(context, 'pipelines').select('*').order('name'),
    scoped(context, 'stages').select('*').order('order'),
  ])

  const pipelineList = (pipelines ?? []) as PipelineRow[]
  const stageList = (stages ?? []) as StageRow[]

  return (
    <>
      <PageHeader
        title="Pipelines & stages"
        description="Each pipeline has its own ordered stages. A stage's default probability is what deals inherit when they land in it."
      />

      <form action={createPipeline} className="card mb-5 flex flex-wrap items-end gap-2 p-4">
        <div>
          <label className="label" htmlFor="pipeline-name">
            New pipeline
          </label>
          <input id="pipeline-name" name="name" required className="input w-64" placeholder="Trading desk" />
        </div>
        <button type="submit" className="btn-primary">
          Add pipeline
        </button>
      </form>

      <div className="space-y-5">
        {pipelineList.map((pipeline) => {
          const pipelineStages = stageList.filter((stage) => stage.pipeline_id === pipeline.id)

          return (
            <Section
              key={pipeline.id}
              title={pipeline.name}
              actions={
                <div className="flex items-center gap-2">
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
                  <form action={deletePipeline}>
                    <input type="hidden" name="id" value={pipeline.id} />
                    <button type="submit" className="text-xs text-slate-400 hover:text-red-600">
                      Delete
                    </button>
                  </form>
                </div>
              }
            >
              <table className="table mb-3">
                <thead>
                  <tr>
                    <th className="w-20">Order</th>
                    <th>Stage</th>
                    <th className="w-40">Default probability</th>
                    <th className="w-32" />
                  </tr>
                </thead>
                <tbody>
                  {pipelineStages.map((stage) => (
                    <tr key={stage.id}>
                      <td colSpan={4} className="p-0">
                        <form action={updateStage} className="flex items-center gap-2 px-3 py-2">
                          <input type="hidden" name="id" value={stage.id} />
                          <input
                            name="order"
                            type="number"
                            defaultValue={stage.order}
                            className="input w-20"
                            aria-label="Order"
                          />
                          <input
                            name="name"
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
                          <button type="submit" className="btn-secondary">
                            Save
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flex flex-wrap items-center gap-3">
                <form action={createStage} className="flex flex-wrap items-end gap-2">
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
                  <button type="submit" className="btn-secondary">
                    Add stage
                  </button>
                </form>

                {pipelineStages.length > 0 && (
                  <form action={deleteStage} className="flex items-end gap-2">
                    <select name="id" className="input w-52" aria-label="Stage to delete">
                      {pipelineStages.map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.name}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="btn-danger">
                      Delete stage
                    </button>
                  </form>
                )}
              </div>
            </Section>
          )
        })}
      </div>
    </>
  )
}
