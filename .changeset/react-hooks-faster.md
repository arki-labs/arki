---
'@arki/react-hooks': patch
---

`@arki/react-hooks/media-query` no longer imports React itself: `useIsMobile`, `useIsTablet`, `useIsDesktop`, `useIsTabletOrDesktop` and `useIsTouchDevice` are now built on the re-exported @mantine/hooks `useMediaQuery` (same SSR-safe behaviour: the default value first, the real match after the first effect). A bundle that only takes `useMediaQuery` is now exactly the size of @mantine/hooks used directly (316 B gzip, was 328 B).
