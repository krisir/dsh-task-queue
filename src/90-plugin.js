/**
 * Plugin entry: dictionaries, the stylesheet, and the view registration.
 *
 * Registration layout: one entry in `conversation.view`, the session-scoped list
 * the shell renders one at a time. It already holds `chat` (order 0) and
 * `trajectory` (order 10), so this takes a fresh id at order 20 and sits third —
 * beside them rather than in either of their cells.
 *
 * Everything the page shows comes from the host half over one HTTP route, and
 * the page re-reads it on a slow poll. The queue's truth — what is queued, what
 * is running, what the window is — lives on the host, because a browser tab is
 * not a scheduler.
 */

const NS = 'taskQueue';

/**
 * The view id, which is also the tab key the shell remembers per session.
 *
 * It must not collide with a shipped view: reusing `chat` or `trajectory` would
 * take over that cell and replace the built-in page instead of sitting beside it.
 */
const VIEW_ID = 'task-queue';

/** Simplified Chinese dictionary — the key-set source of truth. */
const zh = {
	'view.label': '任务',
	'page.title': '任务队列',
	'page.tabQueue': '队列',
	'page.tabSettings': '设置',
	'page.tabArchive': '归档',
	'page.loading': '正在读取队列…',
	'page.noWorkspace': '当前会话没有归属任何工作区，因此没有队列。先把它放进一个工作区，任务才知道该在哪里执行。',

	'status.open': '执行中',
	'status.closed': '时段外',
	'status.paused': '已暂停',
	'status.pausedNote': '队列已暂停：任务会一直排队，直到你重新启用。',
	'status.noWindow': '未设时段',
	'status.noWindowNote': '这个工作区还没有设置执行时段，任务只会排队，不会自动执行。到「设置」里加一个时段。',
	'status.openNote': '正在执行时段内 · 运行中 {running} · 排队 {queued}',
	'status.closesIn': '{amount}后进入时段外',
	'status.closedNote': '当前时段外，{queued} 个任务在排队',
	'status.opensAt': '将于 {time} 开始（{amount}）',
	'status.cooldownNote': '执行间隔中：{amount}后开始下一个任务（排队 {queued} 个，间隔 {minutes} 分钟）',

	'status.queued': '排队中',
	'status.running': '执行中',
	'status.done': '已完成',
	'status.failed': '失败',
	'status.cancelled': '已取消',

	'window.overnight': '{start} ～ 次日 {end}',
	'window.sameDay': '{start} ～ {end}',
	'window.none': '（没有时段）',

	'duration.days': '{count} 天',
	'duration.hours': '{count} 小时',
	'duration.minutes': '{count} 分钟',
	'duration.lessThanMinute': '不到 1 分钟',
	'duration.until': '{amount}后',
	'duration.since': '{amount}前',

	'compose.title': '标题',
	'compose.titlePlaceholder': '一句话说明这个任务（可留空，取正文首行）',
	'compose.prompt': '任务内容',
	'compose.promptPlaceholder': '写给 AI 的指令，例如：把 src 下所有 console.log 清掉并跑一遍测试…',
	'compose.hint': 'Ctrl/⌘ + Enter 快速加入',
	'compose.add': '加入队列',

	'queue.empty': '队列是空的。在上面写一条任务，到点后会由 AI 自动执行。',
	'archive.empty': '归档是空的。已完成的任务归档后会留在这里。',
	'archive.restore': '移回队列',
	'archive.restoreHint': '把它移回任务列表',
	'archive.clear': '清空归档',
	'archive.clearConfirm': '确认清空？',
	'archive.clearWarning': '清空后无法恢复。',
	'archive.clearFailed': '清空归档失败，请重试。',
	'queue.addTitle': '新建任务',
	'queue.archiveDone': '归档已完成',
	'queue.unassigned': '有 {count} 个旧任务没有归属工作区。',
	'queue.adopt': '归入当前工作区',

	'card.editTitle': '任务标题',
	'card.editPrompt': '任务内容',
	'card.cancelEdit': '取消',
	'card.save': '保存',
	'card.attempts': '第 {count} 次',
	'card.session': '会话 {id}',
	'card.moveUp': '上移一位',
	'card.moveDown': '下移一位',
	'card.edit': '编辑',
	'card.runNow': '执行',
	'card.runNowHint': '立即执行这个任务，忽略执行时段',
	'card.retry': '重新排队',
	'card.cancel': '取消任务',
	'card.delete': '删除',
	'card.finishedAt': '完成于 {time}',

	'settings.windowGroup': '执行时段',
	'settings.windowGroupHint': '可以有多个时段，任意一个到点都会开始执行。开始时间晚于结束时间表示跨到第二天。',
	'settings.windowStart': '第 {index} 个时段的开始时间',
	'settings.windowEnd': '第 {index} 个时段的结束时间',
	'settings.addWindow': '添加时段',
	'settings.removeWindow': '删除第 {index} 个时段',
	'settings.windowEmpty': '没有时段时，任务只会排队，不会自动执行。',
	'settings.enabled': '启用自动执行',
	'settings.enabledHint': '关闭后只创建任务，任何时间都不会自动执行。',
	'settings.start': '开始时间',
	'settings.end': '结束时间',
	'settings.timeZone': '时区',
	'settings.timeZoneHint': 'IANA 时区名，例如 Asia/Shanghai。浏览器当前为 {zone}。',
	'settings.windowPreview': '生效区间：{window}',
	'settings.execGroup': '执行方式',
	'settings.autoApprove': '自动跳过所有授权',
	'settings.autoApproveHint':
		'任务会话切到完全访问权限，所有需要确认的操作由队列直接放行。只对队列自己驱动的会话生效，不影响你手动打开的会话。',
	'settings.targetMode': '任务执行位置',
	'settings.targetFresh': '每个任务新建一个会话',
	'settings.targetShared': '共用一个会话（推荐）',
	'settings.targetHint': '共用一个会话时，任务之间可以接续上下文，结果也都在这一个会话里；打开下面的会话压缩可以避免上下文越滚越大。',
	'settings.cooldown': '执行间隔（分钟）',
	'settings.cooldownHint':
		'上一个任务结束后等这么久再开始下一个。0 表示不等待，有空位就接着执行。只对当前工作区生效，每个工作区各设各的。',
	'settings.compact': '任务执行前压缩会话',
	'settings.compactHint':
		'只在「共用会话 / 固定会话」下有意义：每个任务开始前先把会话压缩成摘要，避免前面任务的上下文越滚越大。每个任务新建会话时不需要，也不会触发。',
	'settings.timeout': '单任务超时（分钟）',
	'settings.unsaved': '有未保存的修改',
	'settings.refused': '宿主未接受：{fields}',
	'settings.discard': '撤销',
	'settings.save': '保存设置',
};

/** English dictionary, checked complete against the zh key set. */
const en = {
	'view.label': 'Tasks',
	'page.title': 'Task queue',
	'page.tabQueue': 'Queue',
	'page.tabSettings': 'Settings',
	'page.tabArchive': 'Archive',
	'page.loading': 'Reading the queue…',
	'page.noWorkspace': 'This session does not belong to a workspace, so it has no queue. Put it in one first, and tasks will know where to run.',

	'status.open': 'Running',
	'status.closed': 'Outside window',
	'status.paused': 'Paused',
	'status.pausedNote': 'The queue is paused: tasks keep stacking up until you enable it again.',
	'status.noWindow': 'No window',
	'status.noWindowNote': 'This workspace has no execution window yet, so tasks only queue up. Add one under Settings.',
	'status.openNote': 'Inside the execution window · {running} running · {queued} waiting',
	'status.closesIn': 'closes in {amount}',
	'status.closedNote': 'Outside the window, {queued} task(s) waiting',
	'status.opensAt': 'starts at {time} ({amount})',
	'status.cooldownNote': 'Pacing: the next task starts in {amount} ({queued} waiting, {minutes} min apart)',

	'status.queued': 'Queued',
	'status.running': 'Running',
	'status.done': 'Done',
	'status.failed': 'Failed',
	'status.cancelled': 'Cancelled',

	'window.overnight': '{start} to {end} next day',
	'window.sameDay': '{start} to {end}',
	'window.none': '(no windows)',

	'duration.days': '{count}d',
	'duration.hours': '{count}h',
	'duration.minutes': '{count}m',
	'duration.lessThanMinute': 'under a minute',
	'duration.until': 'in {amount}',
	'duration.since': '{amount} ago',

	'compose.title': 'Title',
	'compose.titlePlaceholder': 'One line naming the task (blank takes the first line of the text)',
	'compose.prompt': 'Task',
	'compose.promptPlaceholder': 'The instruction for the agent, e.g. remove every console.log under src and run the tests…',
	'compose.hint': 'Ctrl/⌘ + Enter to add',
	'compose.add': 'Add to queue',

	'queue.empty': 'The queue is empty. Write a task above and the agent will run it once the window opens.',
	'archive.empty': 'The archive is empty. Tasks you file away after finishing show up here.',
	'archive.restore': 'Restore',
	'archive.restoreHint': 'Put it back in the task list',
	'archive.clear': 'Clear archive',
	'archive.clearConfirm': 'Really clear?',
	'archive.clearWarning': 'This cannot be undone.',
	'archive.clearFailed': 'Could not clear the archive; try again.',
	'queue.addTitle': 'New task',
	'queue.archiveDone': 'Archive completed',
	'queue.unassigned': '{count} older task(s) belong to no workspace.',
	'queue.adopt': 'Adopt into this workspace',

	'card.editTitle': 'Task title',
	'card.editPrompt': 'Task text',
	'card.cancelEdit': 'Cancel',
	'card.save': 'Save',
	'card.attempts': 'attempt {count}',
	'card.session': 'session {id}',
	'card.moveUp': 'Move up one',
	'card.moveDown': 'Move down one',
	'card.edit': 'Edit',
	'card.runNow': 'Run',
	'card.runNowHint': 'Run this task now, ignoring the execution window',
	'card.retry': 'Re-queue',
	'card.cancel': 'Cancel task',
	'card.delete': 'Delete',
	'card.finishedAt': 'finished {time}',

	'settings.windowGroup': 'Execution windows',
	'settings.windowGroupHint': 'Add as many as you like; the queue runs when any one of them is open. A start later than the end wraps to the next day.',
	'settings.windowStart': 'Start time of window {index}',
	'settings.windowEnd': 'End time of window {index}',
	'settings.addWindow': 'Add window',
	'settings.removeWindow': 'Remove window {index}',
	'settings.windowEmpty': 'With no window, tasks only queue up and never run by themselves.',
	'settings.enabled': 'Enable automatic execution',
	'settings.enabledHint': 'When off, tasks are only created and never run automatically.',
	'settings.start': 'Start time',
	'settings.end': 'End time',
	'settings.timeZone': 'Time zone',
	'settings.timeZoneHint': 'An IANA zone name such as Asia/Shanghai. The browser reports {zone}.',
	'settings.windowPreview': 'In effect: {window}',
	'settings.execGroup': 'How tasks run',
	'settings.autoApprove': 'Skip every authorization',
	'settings.autoApproveHint':
		'Task sessions get full file access and the queue answers every confirmation itself. Only sessions the queue drives are affected — never a session you opened by hand.',
	'settings.targetMode': 'Where a task runs',
	'settings.targetFresh': 'A fresh session per task',
	'settings.targetShared': 'One shared session (recommended)',
	'settings.targetHint': 'A shared session lets the tasks build on each other and keeps every result in one conversation; turn on compaction below to stop that conversation growing without bound.',
	'settings.cooldown': 'Interval between tasks (minutes)',
	'settings.cooldownHint':
		'Wait this long after one task finishes before starting the next. 0 starts the next one as soon as a slot is free. Per workspace: each one keeps its own interval.',
	'settings.compact': 'Compact the session before each task',
	'settings.compactHint':
		'Only meaningful for a shared or pinned session: compacting keeps each task starting from a summary instead of everything the earlier tasks left behind. A fresh session per task never triggers it.',
	'settings.timeout': 'Task timeout (minutes)',
	'settings.unsaved': 'Unsaved changes',
	'settings.refused': 'The host did not accept: {fields}',
	'settings.discard': 'Discard',
	'settings.save': 'Save settings',
};

/** Cordis client services this plugin's `apply` waits for. */
const inject = ['slots', 'locale'];

/**
 * Client plugin body.
 * @param {object} ctx - the client root context.
 */
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'task-queue: dictionaries');
	ctx.effect(() => installStyles(), 'task-queue: stylesheet');

	// One full-page view, beside the shipped 对话 (`chat`) and 轨迹 (`trajectory`)
	// entries — the conversation view list is `[chat(0), trajectory(10), …]`, so
	// an order of 20 puts this third. `label` is what the shell projects into the
	// tab row; without it the tab would read as the raw slot id.
	//
	// The entry is session-scoped and its `inject` receives the session id, which
	// is what makes the page a *workspace's* page: the id travels with every
	// request and the Host resolves it, so the page never has to know — or be
	// trusted with — a workspace identity of its own.
	const label = ctx.locale.bind(NS);
	ctx.slots.inject('conversation.view', () =>
		ctx.slots.register(
			{
				name: 'conversation.view',
				id: VIEW_ID,
				order: 20,
				locale: NS,
				label: () => label('view.label'),
				inject: (sessionId) => ({ sessionId }),
			},
			TaskQueuePage,
		),
	);
}
