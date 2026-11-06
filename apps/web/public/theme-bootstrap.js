(() => {
  const stored = localStorage.getItem('quillum.theme-preference')
  const preference = stored === 'light' || stored === 'dark' || stored === 'system'
    ? stored
    : 'system'
  const theme = preference === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference
  document.documentElement.dataset.themePreference = preference
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelectorAll('meta[data-theme-color]').forEach((meta) => {
    const metaTheme = meta.dataset.themeColor
    meta.setAttribute(
      'media',
      preference === 'system'
        ? `(prefers-color-scheme: ${metaTheme})`
        : metaTheme === theme ? 'all' : 'not all',
    )
  })
})()
