Settings:
- text: System notifications Notify when a task finishes or needs your input while this window is in the background. Saved for this browser or device.
- status: System permissions and focus modes may suppress reminders
- switch "System notifications" [checked]

Approval notification:
  title: DeepSeek Harness needs your attention
  body: An operation needs approval. Click to open the conversation.
  tag: {{request}}

Task completion notification:
  title: DeepSeek Harness · Task completed
  body: Your task has finished. Click to open the conversation.
  tag: {{session}}

Background work completion policy:
  waiting turn notifications: 0
  job settlement notifications: 0
  subsequent completed turn notifications: 1
