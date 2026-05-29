angular.module('kityminderEditor')

	.directive('noteEditor', ['valueTransfer', function(valueTransfer) {
		return {
			restrict: 'A',
			templateUrl: 'ui/directive/noteEditor/noteEditor.html',
			scope: {
				minder: '='
			},
			replace: true,
			link: function($scope, element) {
				var minder = $scope.minder;
				var isInteracting = false;
				var vditorEditor;
				var activeNode;
				var lastMarkdown = '';
				var pendingMarkdown = '';
				var dirty = false;
				var flushTimer;
				var maxFlushTimer;
				var interactChangeBound = false;
				var lastReadOnly;
				var IDLE_FLUSH_DELAY = 800;
				var MAX_FLUSH_DELAY = 3000;
				$scope.noteEnabled = false;
				$scope.noteContent = '';
				$scope.noteEditorUnavailable = false;

				function ensureEditor() {
					if (vditorEditor || $scope.noteEditorUnavailable) return;
					var host = element[0].querySelector('.vditor-note-host');
					if (!host || !window.VditorNote || !window.VditorNote.createVditorNoteEditor) {
						$scope.noteEditorUnavailable = true;
						return;
					}
					vditorEditor = window.VditorNote.createVditorNoteEditor(host, {
						markdown: '',
						readOnly: true,
						onChange: scheduleNoteWrite
					});
				}

				function isPanelOpen() {
					return !!valueTransfer.noteEditorOpen;
				}

				function clearFlushTimers() {
					clearTimeout(flushTimer);
					clearTimeout(maxFlushTimer);
					flushTimer = null;
					maxFlushTimer = null;
				}

				function scheduleFlush() {
					clearTimeout(flushTimer);
					flushTimer = setTimeout(flushPendingNote, IDLE_FLUSH_DELAY);
					if (!maxFlushTimer) {
						maxFlushTimer = setTimeout(flushPendingNote, MAX_FLUSH_DELAY);
					}
				}

				function scheduleNoteWrite(content) {
					if (isInteracting) return;
					pendingMarkdown = content || '';
					dirty = true;
					scheduleFlush();
				}

				function commitMarkdownToNode(node, markdown) {
					if (!node) return;
					var current = node.getData('note') || '';
					if (markdown === current) return;
					node.setData('note', markdown);
					node.render();
					node.getMinder().layout(300);
					node.getMinder().fire('contentchange');
					if (node.getMinder()._interactChange) {
						node.getMinder()._interactChange();
					}
				}

				function flushPendingNote() {
					var markdown = vditorEditor ? vditorEditor.getMarkdown() : pendingMarkdown;
					markdown = markdown || '';
					clearFlushTimers();
					if (!dirty && markdown === lastMarkdown) return;
					commitMarkdownToNode(activeNode, markdown);
					lastMarkdown = markdown;
					pendingMarkdown = markdown;
					dirty = false;
				}

				function setEditorReadOnly(readOnly) {
					if (!vditorEditor || lastReadOnly === readOnly) return;
					vditorEditor.setReadOnly(readOnly);
					lastReadOnly = readOnly;
				}

				function syncNoteState() {
					if (!isPanelOpen()) return;
					ensureEditor();
					var enabled = $scope.noteEnabled = minder.queryCommandState('note') != -1;
					var node = enabled ? minder.getSelectedNode() : null;
					var noteValue = minder.queryCommandValue('note') || '';

					$scope.noteContent = enabled ? noteValue : '';
					if (vditorEditor) {
						var readOnly = !enabled;
						var markdownChanged = node !== activeNode || $scope.noteContent !== lastMarkdown;

						isInteracting = true;
						setEditorReadOnly(readOnly);
						if (markdownChanged) {
							clearFlushTimers();
							activeNode = node;
							lastMarkdown = $scope.noteContent;
							pendingMarkdown = $scope.noteContent;
							dirty = false;
							vditorEditor.setMarkdown($scope.noteContent);
						}
						setTimeout(function() {
							isInteracting = false;
						});
					}
				}

				function updateNote() {
					if (!isPanelOpen()) return;
					var enabled = minder.queryCommandState('note') != -1;
					var node = enabled ? minder.getSelectedNode() : null;
					if (node !== activeNode) {
						flushPendingNote();
						syncNoteState();
					} else if (!dirty) {
						syncNoteState();
					}
					$scope.$evalAsync();
				}

				function bindInteractChange() {
					if (interactChangeBound) return;
					minder.on('interactchange', updateNote);
					interactChangeBound = true;
				}

				function unbindInteractChange() {
					if (!interactChangeBound) return;
					minder.off('interactchange', updateNote);
					interactChangeBound = false;
				}

				function destroyEditor() {
					if (vditorEditor) {
						vditorEditor.destroy();
						vditorEditor = null;
					}
					activeNode = null;
					lastMarkdown = '';
					pendingMarkdown = '';
					dirty = false;
					lastReadOnly = null;
				}

				function deactivateEditor() {
					flushPendingNote();
					clearFlushTimers();
					unbindInteractChange();
					destroyEditor();
				}

				var noteEditorOpen = function() {
					return valueTransfer.noteEditorOpen;
				};

				// 监听面板状态变量的改变
				$scope.$watch(noteEditorOpen, function(newVal, oldVal) {
					if (newVal) {
						bindInteractChange();
						syncNoteState();
						setTimeout(function() {
							if (vditorEditor) {
								vditorEditor.focus();
							}
						});
					} else if (oldVal) {
						deactivateEditor();
					}
					$scope.noteEditorOpen = valueTransfer.noteEditorOpen;
				}, true);


				$scope.closeNoteEditor = function() {
					flushPendingNote();
					valueTransfer.noteEditorOpen = false;
					editor.receiver.selectAll();
				};

				minder.on('flushnoterequest', flushPendingNote);
				$scope.$on('$destroy', function() {
					deactivateEditor();
					minder.off('flushnoterequest', flushPendingNote);
				});
			}
		}
	}]);
