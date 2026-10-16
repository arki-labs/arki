---
'@arki/dot': minor
---

`dot explain` prints each action's summary, and a plugin can finish its own summaries after boot.

- New hook `$describeAction(actionId, { summary })` (configure twin: `describeAction`). A plugin calls it after boot to complete the summary of its own actions, or of actions in a binding it registered a projection for. The post-boot manifest and `dot doctor` show the completed text.
- New error `DOT_LIFECYCLE_E021`, raised when a plugin describes an action it may not amend (an unknown id, or one that is not its own).
