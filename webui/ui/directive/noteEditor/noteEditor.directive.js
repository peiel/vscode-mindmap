angular.module('kityminderEditor')

	.directive('noteEditor', ['valueTransfer', function(valueTransfer) {
		return {
			restrict: 'A',
			templateUrl: 'ui/directive/noteEditor/noteEditor.html',
			scope: {
				minder: '='
			},
			replace: true,
			controller: function($scope) {
				var minder = $scope.minder;
				var isInteracting = false;
				var cmEditor;
				$scope.noteEnabled = false;
				$scope.noteContent = '';

				$scope.codemirrorLoaded =  function(_editor) {

					cmEditor = $scope.cmEditor = _editor;

					_editor.setSize('100%', '100%');
					_editor.setOption('readOnly', $scope.noteEnabled ? false : 'nocursor');
				};

				function syncNoteState() {
					var enabled = $scope.noteEnabled = minder.queryCommandState('note') != -1;
					var noteValue = minder.queryCommandValue('note') || '';

					$scope.noteContent = enabled ? noteValue : '';
					if (cmEditor) {
						cmEditor.setOption('readOnly', enabled ? false : 'nocursor');
					}
				}

				function updateNote() {
					isInteracting = true;
					syncNoteState();
					$scope.$apply();
					isInteracting = false;
				}


				$scope.$watch('noteContent', function(content) {
					var enabled = minder.queryCommandState('note') != -1;

					if (content && enabled && !isInteracting) {
						minder.execCommand('note', content);
					}

					setTimeout(function() {
						if (cmEditor) {
							cmEditor.refresh();
						}
					});
				});


				var noteEditorOpen = function() {
					return valueTransfer.noteEditorOpen;
				};

				// 监听面板状态变量的改变
				$scope.$watch(noteEditorOpen, function(newVal, oldVal) {
					if (newVal) {
						isInteracting = true;
						syncNoteState();
						setTimeout(function() {
							isInteracting = false;
							if (cmEditor) {
								cmEditor.refresh();
								cmEditor.focus();
							}
						});
					}
					$scope.noteEditorOpen = valueTransfer.noteEditorOpen;
				}, true);


				$scope.closeNoteEditor = function() {
					valueTransfer.noteEditorOpen = false;
					editor.receiver.selectAll();
				};



				minder.on('interactchange', updateNote);
			}
		}
	}]);
