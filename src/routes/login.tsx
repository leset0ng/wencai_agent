import { createFileRoute } from '@tanstack/react-router'
import { AuthPage } from '#/components/banking/AuthPage'
export const Route = createFileRoute('/login')({ component: () => <AuthPage /> })
