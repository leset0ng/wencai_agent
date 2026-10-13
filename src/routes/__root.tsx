import { HeadContent, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'
import { UIProvider } from '#/components/ui/provider'

interface MyRouterContext {
  queryClient: QueryClient
}

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: '文财 · 银行 AI 智能体' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }, { rel: 'icon', href: '/favicon.svg' }],
  }),
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <div className="mx-auto flex h-dvh max-w-md flex-col items-center justify-center gap-3 bg-[var(--bg-base)] px-4">
      <p className="m-0 text-lg font-semibold text-[var(--sea-ink)]">页面不存在</p>
      <a className="text-sm text-[var(--lagoon-deep)] underline" href="/">
        返回文财
      </a>
    </div>
  ),
  errorComponent: ({ error }: { error: unknown }) => (
    <div className="mx-auto flex h-dvh max-w-md flex-col items-center justify-center gap-3 bg-[var(--bg-base)] px-4">
      <p className="m-0 text-lg font-semibold text-[var(--sea-ink)]">出错了</p>
      <p className="m-0 text-center text-sm text-[var(--sea-ink-soft)]">{error instanceof Error ? error.message : '未知错误'}</p>
      <a className="text-sm text-[var(--lagoon-deep)] underline" href="/">
        返回文财
      </a>
    </div>
  ),
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "if(window.location.pathname==='/secure-operation'){document.documentElement.dataset.secureDocument='true';document.documentElement.style.background='#fff'}" }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere]">
        <UIProvider>{children}</UIProvider>
        {import.meta.env.DEV && (
          <TanStackDevtools
            config={{ position: 'bottom-right' }}
            plugins={[{ name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> }, TanStackQueryDevtools]}
          />
        )}
        <Scripts />
      </body>
    </html>
  )
}
