/** Codex sign-in copy. One namespace, two dictionaries with identical key sets. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin's browser half. */
export const CODEX_OAUTH_LOCALE_NAMESPACE = 'dsh-llm-codex-account'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Codex sign-in section's copy. */
    'dsh-llm-codex-account': CodexOAuthLocaleKey
  }
}

/** Simplified Chinese dictionary; its key set is this namespace's key union. */
const zh = {
  'nav': 'Codex 登录',
  'info.balance': 'DeepSeek 账户余额',
  'info.remaining': 'Codex 剩余额度',
  'info.fiveHourShort': '5 小时 {percent}',
  'info.weekShort': '周 {percent}',
  'info.separator': ' · ',
  'info.fiveHourReset': '5 小时额度重置：',
  'info.weekReset': '周额度重置：',
  'info.updated': '更新时间：',
  'card.title': '使用 ChatGPT 登录',
  'card.recordStored': '已保存登录记录。',
  'card.recordAbsent': '尚未登录。',
  'card.loading': '正在读取登录状态…',
  'card.loginUnavailable': '官方能力不完整，暂不能登录。',
  'card.refresh': '刷新状态',
  'card.retry': '重试',
  'gap.authorization-unavailable': '官方授权服务不可用，无法开始登录。',
  'gap.credentials-unavailable': '官方凭据存储不可用，无法保存登录。',
  'gap.codex-flow-unavailable': '官方未提供 Codex 授权流程，请确认 llm-pi-ai 适配器已安装并启用。',
  'gap.settings-unavailable': '官方设置服务不可用，无法检查模型路由。',
  'gap.connection-unavailable': '与 Host 的通信通道不可用，请重试。',
  'login.start': '登录',
  'login.restart': '重新登录',
  'login.starting': '正在开始登录…',
  'login.waiting': '请在浏览器中完成授权。',
  'login.reopen': '重新打开授权页',
  'login.cancel': '取消登录',
  'login.authorized': '登录成功。',
  'cancelled.user': '登录已取消。',
  'cancelled.browser-open-failed': '未能请求打开授权页，登录已停止。',
  'cancelled.page-closed': '设置页已关闭，登录已停止。',
  'cancelled.timeout': '等待授权超时，登录已停止。',
  'cancelled.unload': '插件已卸载，登录已停止。',
  'failure.invalid-request': '请求未通过校验。',
  'failure.transport-failed': '与 Host 的通信失败。',
  'failure.capability-unavailable': '官方能力不可用，无法完成该操作。',
  'failure.provider-unsupported': '该操作只支持 openai-codex。',
  'failure.busy': '已有一次 Codex 登录在进行中，请先完成或取消它。',
  'failure.attempt-unknown': '该登录尝试已不存在。',
  'failure.attempt-forbidden': '该登录尝试由其他页面发起，本页无法操作。',
  'failure.attempt-expired': '该登录尝试已超时或被回收，请重新登录；本机记录以刷新后的结果为准。',
  'failure.login-failed': '官方登录流程未能完成，请重试。',
  'failure.login-method-unsupported': '官方登录流程提出了本插件不支持的交互方式，请确认 llm-pi-ai 版本。',
  'failure.callback-port-unavailable': '本机回调端口 1455 不可用：端口被占用，或回调主机不是回环地址。请释放后重试。',
  'failure.logout-blocked': '有登录尝试进行中，此时不能删除凭据记录。',
  'failure.route-revision-conflict': 'llm-pi-ai 设置在你读取之后发生了变化，请刷新后重试。',
  'failure.route-write-failed': '自动启用模型失败，请重试。',
  'logout.request': '退出',
  'logout.confirm': '确认删除本机 Codex 凭据记录？',
  'logout.confirmNote': '这只删除本机保存的凭据记录，不会撤销 OpenAI 服务端的授权，也不会删除模型路由配置或其他 provider 配置。',
  'logout.confirmYes': '删除本机记录',
  'logout.confirmNo': '取消',
  'logout.running': '正在删除本机凭据记录…',
  'logout.removed': '已删除本机凭据记录；模型路由配置未改动。',
} as const

/** English dictionary, checked against the Chinese key set at compile time. */
const en = {
  'nav': 'Codex sign-in',
  'info.balance': 'DeepSeek account balance',
  'info.remaining': 'Codex remaining quota',
  'info.fiveHourShort': '5h {percent}',
  'info.weekShort': 'week {percent}',
  'info.separator': ' · ',
  'info.fiveHourReset': '5-hour reset:',
  'info.weekReset': 'Weekly reset:',
  'info.updated': 'Updated:',
  'card.title': 'Sign in with ChatGPT',
  'card.recordStored': 'A sign-in record is saved.',
  'card.recordAbsent': 'Not signed in.',
  'card.loading': 'Reading the sign-in state…',
  'card.loginUnavailable': 'An official service is missing, so sign-in is unavailable.',
  'card.refresh': 'Refresh state',
  'card.retry': 'Retry',
  'gap.authorization-unavailable': 'The official authorization service is unavailable, so sign-in cannot start.',
  'gap.credentials-unavailable': 'The official credential store is unavailable, so a sign-in cannot be saved.',
  'gap.codex-flow-unavailable': 'No official Codex authorization flow is installed; check that the llm-pi-ai adapter is installed and enabled.',
  'gap.settings-unavailable': 'The official settings service is unavailable, so the model route cannot be checked.',
  'gap.connection-unavailable': 'The channel to the Host is unavailable; try again.',
  'login.start': 'Sign in',
  'login.restart': 'Sign in again',
  'login.starting': 'Starting sign-in…',
  'login.waiting': 'Complete authorization in your browser.',
  'login.reopen': 'Reopen authorization page',
  'login.cancel': 'Cancel sign-in',
  'login.authorized': 'Sign-in completed.',
  'cancelled.user': 'Sign-in was cancelled.',
  'cancelled.browser-open-failed': 'The authorization page could not be requested, so the sign-in stopped.',
  'cancelled.page-closed': 'The settings page closed, so the sign-in stopped.',
  'cancelled.timeout': 'The wait for authorization timed out, so the sign-in stopped.',
  'cancelled.unload': 'The plugin unloaded, so the sign-in stopped.',
  'failure.invalid-request': 'The request failed validation.',
  'failure.transport-failed': 'Communication with the Host failed.',
  'failure.capability-unavailable': 'An official service is missing, so that operation cannot run.',
  'failure.provider-unsupported': 'That operation only supports openai-codex.',
  'failure.busy': 'A Codex sign-in is already running; finish or cancel it first.',
  'failure.attempt-unknown': 'That sign-in attempt no longer exists.',
  'failure.attempt-forbidden': 'Another page started that sign-in attempt, so this page cannot act on it.',
  'failure.attempt-expired': 'That sign-in attempt timed out or was reclaimed; start again and read the refreshed record state.',
  'failure.login-failed': 'The official sign-in flow did not complete; try again.',
  'failure.login-method-unsupported': 'The official flow asked for an interaction this plugin does not answer; check the llm-pi-ai version.',
  'failure.callback-port-unavailable': 'Local callback port 1455 is unavailable: it is occupied, or the configured callback host is not a loopback address. Free it and try again.',
  'failure.logout-blocked': 'A sign-in attempt is running, so the credential record must not be deleted right now.',
  'failure.route-revision-conflict': 'The llm-pi-ai settings changed after you read them; refresh and try again.',
  'failure.route-write-failed': 'Models could not be enabled automatically. Try again.',
  'logout.request': 'Sign out',
  'logout.confirm': 'Delete the local Codex credential record?',
  'logout.confirmNote': 'This deletes only the credential record stored on this machine. It does not revoke the OpenAI authorization and does not remove the model route or any other provider configuration.',
  'logout.confirmYes': 'Delete the local record',
  'logout.confirmNo': 'Cancel',
  'logout.running': 'Deleting the local credential record…',
  'logout.removed': 'The local credential record was deleted; the model route is unchanged.',
} satisfies Record<keyof typeof zh, string>

/** Every copy key of this namespace. */
export type CodexOAuthLocaleKey = keyof typeof zh

export { en, zh }
