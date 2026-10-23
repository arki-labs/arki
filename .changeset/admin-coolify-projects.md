---
'@arki/admin': patch
---

The Coolify client reads projects and their environments (`listProjects`, `listEnvironments`), so a caller can name an application's project from its `environment_id`. Applications now also carry `environment_id`, `base_directory`, `dockerfile_location`, `docker_compose_location` and `watch_paths`. No docs impact beyond the Coolify connection README. No demo impact: the Coolify connection has no demo.
