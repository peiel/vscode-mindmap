// TODO: 使用一个 div 容器作为 previewer，而不是两个
angular.module('kityminderEditor')

	.directive('notePreviewer', ['$sce', function($sce) {
		return {
			restrict: 'A',
			templateUrl: 'ui/directive/notePreviewer/notePreviewer.html',
			link: function(scope, element) {
				var minder = scope.minder;
				var $container = element.parent();
				var $previewer = element.children();
				var previewTimer;
				var hideTimer;
				var previewCacheKey = null;
				var previewCacheHtml = null;
				var previewLive = false;
				var previewHovering = false;
				var HIDE_DELAY = 350;
				scope.showNotePreviewer = false;

				marked.setOptions({
					gfm: true,
					tables: true,
					breaks: true,
					pedantic: false,
					sanitize: true,
					smartLists: true,
					smartypants: false
				});

				function escapeRegExp(text) {
					return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				}

				function getPreviewHtml(note, keyword) {
					note = note || '';
					keyword = keyword || '';
					var cacheKey = note + '\u0000' + keyword;
					if (cacheKey === previewCacheKey) {
						return previewCacheHtml;
					}

					var html = marked(note);
					if (keyword) {
						html = html.replace(new RegExp('(' + escapeRegExp(keyword) + ')', 'ig'), '<span class="highlight">$1</span>');
					}
					previewCacheKey = cacheKey;
					previewCacheHtml = html;
					return html;
				}

				function showNotePreview(e) {
					clearTimeout(previewTimer);
					clearTimeout(hideTimer);
					previewHovering = false;
					if (!e || !e.node) return;
					previewTimer = setTimeout(function() {
						preview(e.node, e.keyword);
					}, 300);
				}

				function forceHidePreview() {
					clearTimeout(previewTimer);
					clearTimeout(hideTimer);
					scope.showNotePreviewer = false;
					previewLive = false;
					previewHovering = false;
					scope.$evalAsync();
				}

				function scheduleHidePreview() {
					clearTimeout(hideTimer);
					hideTimer = setTimeout(function() {
						if (!previewHovering) {
							forceHidePreview();
						}
					}, HIDE_DELAY);
				}

				function hideNotePreview(e) {
					clearTimeout(previewTimer);
					if (!e || !e.node) {
						forceHidePreview();
						return;
					}
					scheduleHidePreview();
				}

				function hideLivePreview() {
					if (!previewLive) return;
					forceHidePreview();
				}

				minder.on('shownoterequest', showNotePreview);
				minder.on('hidenoterequest', hideNotePreview);

				$(document).on('mousedown mousewheel DOMMouseScroll', hideLivePreview);

				element.on('mousedown mousewheel DOMMouseScroll', function(e) {
					e.stopPropagation();
				});

				$previewer.on('mouseenter', function() {
					previewHovering = true;
					clearTimeout(hideTimer);
				});

				$previewer.on('mouseleave', function() {
					previewHovering = false;
					scheduleHidePreview();
				});

				function preview(node, keyword) {
					var icon = node.getRenderer('NoteIconRenderer').getRenderShape();
					var b = icon.getRenderBox('screen');
					var note = node.getData('note');

					$previewer[0].scrollTop = 0;

					var html = getPreviewHtml(note, keyword);
					scope.noteContent = $sce.trustAsHtml(html);
					scope.$apply(); // 让浏览器重新渲染以获取 previewer 提示框的尺寸

					var cw = $($container[0]).width();
					var ch = $($container[0]).height();
					var pw = $($previewer).outerWidth();
					var ph = $($previewer).outerHeight();

					var x = b.cx - pw / 2 - $container[0].offsetLeft;
					var y = b.bottom + 10 - $container[0].offsetTop;

					if (x < 0) x = 10;
					if (x + pw > cw) x = b.left - pw - 10 - $container[0].offsetLeft;
					if (y + ph > ch) y = b.top - ph - 10 - $container[0].offsetTop;

					scope.previewerStyle = {
						'left': Math.round(x) + 'px',
						'top': Math.round(y) + 'px'
					};

					scope.showNotePreviewer = true;

					var view = $previewer[0].querySelector('.highlight');
					if (view) {
						view.scrollIntoView();
					}
					previewLive = true;

					scope.$apply();
				}

				scope.$on('$destroy', function() {
					clearTimeout(previewTimer);
					clearTimeout(hideTimer);
					minder.off('shownoterequest', showNotePreview);
					minder.off('hidenoterequest', hideNotePreview);
					$(document).off('mousedown mousewheel DOMMouseScroll', hideLivePreview);
					$previewer.off('mouseenter mouseleave');
				});
			}
		}
	}]);
