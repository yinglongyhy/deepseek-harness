/** Locale namespace used by annotation UI registrations. */
export const NAMESPACE = 'conversation-annotations'
/** English annotation UI copy and interpolation keys. */
export const en = {
  add: 'Add to conversation', title: 'Annotations', count: '{count} annotations', historyCount: '{count} comments',
  historyLoading: 'Loading message comments…', historyError: 'Cannot verify message comments. Check the connection and reload.',
  clear: 'Clear draft annotations', remove: 'Delete annotation {number}',
  edit: 'Edit annotation {number}', locate: 'Go to source',
  comment: 'Comment', selectedText: 'Selected text:', recordComment: 'User comment:',
  placeholder: 'Optional comment; Enter starts a new line',
  save: 'Save', cancel: 'Cancel',
  empty: 'No comment', error: 'Annotation operation failed. Retry or check the connection.',
  missing: 'The source is missing. The captured quote is preserved.',
  changed: 'The source has changed. The captured quote is preserved.',
  unavailable: 'The source cannot currently be revealed. The captured quote is preserved.',
  editing: 'Save or cancel the annotation comment before sending.',
  loading: 'Loading annotation recovery data; sending is blocked.',
  pending: 'Resolve the existing annotation submission before sending another.',
  busy: 'Saving annotations; sending is blocked.',
  retry: 'Retry original submission', reconcile: 'Check admission',
  accepted: 'Accepted', rejected: 'Rejected', uncertain: 'Admission uncertain',
  frozen: 'Annotations in the original submission are locked. Retry sends the original text and attachments.',
} as const
/** Keys shared by the supported annotation UI translations. */
export type AnnotationKey = keyof typeof en
/** Complete Chinese annotation UI translation. */
export const zh: Record<AnnotationKey, string> = {
  add: '添加到对话', title: '注释', count: '{count} 条注释', historyCount: '{count} 条评论',
  historyLoading: '正在加载消息评论…', historyError: '无法核验消息评论，请检查连接后重新加载。',
  clear: '清空草稿注释', remove: '删除注释 {number}', edit: '编辑注释 {number}', locate: '定位来源',
  comment: '评论', selectedText: '所选文本：', recordComment: '用户评论：',
  placeholder: '可选评论；Enter 换行', save: '保存', cancel: '取消',
  empty: '未添加评论', error: '注释操作失败，请重试或检查连接。',
  missing: '来源已缺失，仍保留所选文本快照。', changed: '来源已改变，仍保留所选文本快照。',
  unavailable: '暂时无法定位来源，仍保留所选文本快照。',
  editing: '请保存或取消注释评论后再发送。', loading: '正在加载注释恢复记录，暂不可发送。',
  pending: '请先确认已有注释提交的接收状态，再发送新内容。', busy: '正在保存注释，暂不可发送。',
  retry: '重试原提交', reconcile: '查询接收状态', accepted: '已接收', rejected: '已拒绝', uncertain: '接收状态不确定',
  frozen: '原提交内的注释已锁定。重试会发送原正文、原附件和原注释快照。',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'conversation-annotations': AnnotationKey }
}
