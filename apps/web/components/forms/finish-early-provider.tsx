"use client"

import {
  createContext,
  useContext,
  useState,
  useTransition,
  type ReactNode,
} from "react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  acceptPullNextAction,
  acceptStartNewAction,
} from "@/lib/actions/execution"
import type { FinishEarlyPrompt } from "@/lib/db/execution-queries"

type FinishEarlyContextValue = {
  openPrompt: (prompt: FinishEarlyPrompt) => void
}

const FinishEarlyContext = createContext<FinishEarlyContextValue | null>(null)

/**
 * Lets a Finish Early button (deep inside the server-rendered timeline) open
 * the quick-start drawer. Finishing an activity flips its status to
 * "completed", which swaps its timeline slot from `ActiveActivityCard` to a
 * plain `ActivityCard` on the very next render — any prompt state kept
 * inside that card would vanish with it. `FinishEarlyProvider` lives above
 * that swap, so the drawer survives it.
 */
export function useFinishEarlyPrompt(): FinishEarlyContextValue {
  const ctx = useContext(FinishEarlyContext)
  if (!ctx)
    throw new Error(
      "useFinishEarlyPrompt must be used within a FinishEarlyProvider"
    )
  return ctx
}

export function FinishEarlyProvider({ children }: { children: ReactNode }) {
  const [prompt, setPrompt] = useState<FinishEarlyPrompt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handlePullNext(timelineActivityId: string) {
    if (!prompt) return
    startTransition(async () => {
      const result = await acceptPullNextAction(
        timelineActivityId,
        prompt.freedStartIso
      )
      if (result.ok) {
        setError(null)
        setPrompt(null)
      } else {
        setError(result.error)
      }
    })
  }

  function handleStartNew(activityId: string, durationMin: number) {
    if (!prompt) return
    startTransition(async () => {
      const result = await acceptStartNewAction({
        activityId,
        startIso: prompt.freedStartIso,
        durationMin,
      })
      if (result.ok) {
        setError(null)
        setPrompt(null)
      } else {
        setError(result.error)
      }
    })
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      setPrompt(null)
      setError(null)
    }
  }

  return (
    <FinishEarlyContext.Provider
      value={{
        openPrompt: (next) => {
          setError(null)
          setPrompt(next)
        },
      }}
    >
      {children}
      <Sheet open={prompt !== null} onOpenChange={handleOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[85vh] overflow-y-auto rounded-t-2xl border-t-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <div
            aria-hidden
            className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted"
          />
          <SheetHeader>
            <SheetTitle>You freed up {prompt?.freedMin ?? 0}m</SheetTitle>
            <SheetDescription>
              Bring the next task forward, start something else, or just stay
              idle.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 px-4 pb-4">
            {prompt?.options.map((option) =>
              option.kind === "pull-next" ? (
                <Button
                  key={`pull-${option.timelineActivityId}`}
                  type="button"
                  variant="outline"
                  className="justify-start"
                  disabled={pending}
                  onClick={() => handlePullNext(option.timelineActivityId)}
                >
                  Start {option.name} ({option.durationMin}m)
                </Button>
              ) : (
                <Button
                  key={`new-${option.activityId}`}
                  type="button"
                  variant="outline"
                  className="justify-start"
                  disabled={pending}
                  onClick={() =>
                    handleStartNew(option.activityId, option.durationMin)
                  }
                >
                  Start {option.name} ({option.durationMin}m)
                </Button>
              )
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setPrompt(null)}
            >
              Stay idle
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </SheetContent>
      </Sheet>
    </FinishEarlyContext.Provider>
  )
}
