import { useToast } from '@/shared/ui/ToastProvider'

/**
 * `onError` for a mutation, as a toast.
 *
 * Without one, a rejected write is indistinguishable from a tap that missed:
 * the button greys for a moment and returns to its idle label with nothing
 * changed and nothing said.
 *
 *     const onMutationError = useMutationErrorToast()
 *     useMutation({ mutationFn: …, onError: onMutationError('retry') })
 */
export function useMutationErrorToast() {
  const showToast = useToast()
  return (verb: string) => (e: unknown) =>
    showToast({
      message: e instanceof Error ? `${verb} failed — ${e.message}` : `${verb} failed`,
      variant: 'err',
    })
}
