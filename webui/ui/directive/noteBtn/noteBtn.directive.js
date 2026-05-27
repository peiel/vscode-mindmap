angular.module('kityminderEditor')
    .directive('noteBtn', ['valueTransfer', function(valueTransfer) {
        return {
            restrict: 'E',
            templateUrl: 'ui/directive/noteBtn/noteBtn.html',
            scope: {
                minder: '='
            },
            replace: true,
            link: function($scope) {
                var minder = $scope.minder;

                $scope.toggleNote = function() {
                    valueTransfer.noteEditorOpen = !valueTransfer.noteEditorOpen;
                };

                $scope.addNote =function() {
                    valueTransfer.noteEditorOpen = true;
                };
            }
        }
    }]);
