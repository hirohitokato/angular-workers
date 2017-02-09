angular.module('FredrikSandell.worker-pool', [])
    .service('WorkerService', ['$q', function ($q) {
    var that = {};
    var urlToAngular;
    var serviceToUrlMap = {};
    var messageIndex = 0;
    var indexToDeferMap = {};
    var importURLs = [];
    /*jshint laxcomma:true */
    /*jshint quotmark: false */
    var workerTemplate = [""
        // Angular needs a global window object \
        , "var window = self;"
        // Skeleton properties to get Angular to load and bootstrap. \
        , "self.history = {};"
        , "self.Node = function () {};"
        , "var document = {"
        , "      readyState: 'complete',"
        , "      cookie: '',"
        , "      querySelector: function () {},"
        , "      createElement: function () {"
        , "          return {"
        , "              pathname: '',"
        , "              setAttribute: function () {}"
        , "          };"
        , "      }"
        , "};"
        // Load Angular: must be on same domain as this script \
        , "importScripts('<URL_TO_ANGULAR>');"
        , "<CUSTOM_DEP_INCLUDES>"
        // Put angular on global scope \
        , "angular = window.angular;"
        , "var workerApp = angular.module('WorkerApp', [<DEP_MODULES>]);"
        , "workerApp.run(['$q'<STRING_DEP_NAMES>, function ($q<DEP_NAMES>) {"
        , "  self.addEventListener('message', function(e) {"
        , "    var input = e.data.input;"
        , "    var output = $q.defer();"
        , "    var id = e.data.id;"
        , "    var promise = output.promise;"
        , "    promise.then(function(success) {"
        , "      self.postMessage({event:'success', id: id, data : success});"
        , "    }, function(reason) {"
        , "      self.postMessage({event:'failure', id: id, data : reason});"
        , "    }, function(update) {"
        , "      self.postMessage({event:'update', id: id, data : update});"
        , "    });"
        , "    <WORKER_FUNCTION>;"
        , "  });"
        , "  self.postMessage({event:'initDone'});"
        , "}]);"
        , "angular.bootstrap(null, ['WorkerApp']);"].join("\n");


        that.setAngularUrl = function(urlToAngularJs) {
        urlToAngular = urlToAngularJs;
        return that;
    };

    that.addDependency = function (serviceName, moduleName, url) {
        serviceToUrlMap[serviceName] = {
            url : url,
            moduleName: moduleName
        };
        return that;
    };

    // add explicit URLs for importScripts(). Use-case: angular or/and worker code uses global libraries.
    that.addImportURL = function (url) {
        importURLs.push(url);
    };		

    that.createAngularWorker = function (depFuncList) {
        //validate the input

        if (!Array.isArray(depFuncList) ||
            depFuncList.length < 3 ||
            typeof depFuncList[depFuncList.length - 1] !== 'function') {
            throw new Error('Input needs to be: [\'input\',\'output\'\/*optional additional dependencies*\/,\n' +
                '    function(workerInput, deferredOutput \/*optional additional dependencies*\/)\n' +
                '        {\/*worker body*\/}' +
            ']');
        }
        if(typeof urlToAngular !== 'string') {
            throw new Error('The url to angular must be defined before worker creation');
        }
        var deferred = $q.defer();

        var dependencyMetaData = createDependencyMetaData(extractDependencyList(depFuncList));

        var blobURL = (window.URL ? URL : webkitURL).createObjectURL(new Blob([
            populateWorkerTemplate(
                workerFunctionToString(
                    depFuncList[depFuncList.length - 1],
                    dependencyMetaData.workerFuncParamList),
                dependencyMetaData
            )], { type: 'application/javascript' }));


        var worker = new Worker(blobURL);

        //wait for the worker to load resources
        worker.addEventListener('message', function (e) {
            var callee = arguments.callee;
            var eventId = e.data.event;
            if (eventId === 'initDone') {
                worker.removeEventListener('message', callee, false);
                //add event listener for each promise
                worker.addEventListener('message', function (e) {
                    var eventId = e.data.event;
                    var messageId = e.data.id;
                    var deferred = indexToDeferMap[messageId];
                    if (eventId === 'initDone') {
                        throw new Error('Received worker initialization in run method. This should already have occurred!');
                    } else if (eventId === 'success') {
                        deferred.resolve(e.data.data);
                        delete indexToDeferMap[messageId];
                    } else if (eventId === 'failure') {
                        deferred.reject(e.data.data);
                        delete indexToDeferMap[messageId];
                    } else if (eventId === 'update') {
                        deferred.notify(e.data.data);
                    } else {
                        deferred.reject(e);
                    }
                });
                deferred.resolve(buildAngularWorker(worker));
            } else {
                deferred.reject(e);
            }
        });

        return deferred.promise;
    };

    function createIncludeStatements(listOfServiceNames) {
        var includeString = '';
        angular.forEach(importURLs, function (url) {
            includeString += 'importScripts(\''+url+'\');';
        });				
        angular.forEach(listOfServiceNames, function (serviceName) {
            if (serviceToUrlMap[serviceName]) {
                includeString += 'importScripts(\''+serviceToUrlMap[serviceName].url+'\');';
            }
        });
        return includeString;
    }

    function createModuleList(listOfServiceNames) {
        var moduleNameList = [];
        angular.forEach(listOfServiceNames, function (serviceName) {
            if (serviceToUrlMap[serviceName]) {
                moduleNameList.push('\'' + serviceToUrlMap[serviceName].moduleName + '\'');
            }
        });
        return moduleNameList.join(',');
    }

    function createDependencyMetaData(dependencyList) {
        var dependencyServiceNames = dependencyList.filter(function(dep) {
            return dep !== 'input' && dep !== 'output' && dep !== '$q';
        });
        var depMetaData = {
            dependencies: dependencyServiceNames,
            moduleList: createModuleList(dependencyServiceNames),
            angularDepsAsStrings: dependencyServiceNames.length > 0 ? ',' + dependencyServiceNames.map(function (dep) {
                return '\'' + dep + '\'';
            }).join(',') : '',
            angularDepsAsParamList: dependencyServiceNames.length > 0 ? ',' + dependencyServiceNames.join(',') : '',
            servicesIncludeStatements: createIncludeStatements(dependencyServiceNames)
        };
        depMetaData.workerFuncParamList = 'input,output'+depMetaData.angularDepsAsParamList;
        return depMetaData;
    }

    function populateWorkerTemplate(workerFunc, dependencyMetaData) {
        return workerTemplate.replace('<URL_TO_ANGULAR>', urlToAngular)
            .replace('<CUSTOM_DEP_INCLUDES>', dependencyMetaData.servicesIncludeStatements)
            .replace('<DEP_MODULES>', dependencyMetaData.moduleList)
            .replace('<STRING_DEP_NAMES>', dependencyMetaData.angularDepsAsStrings)
            .replace('<DEP_NAMES>', dependencyMetaData.angularDepsAsParamList)
            .replace('<WORKER_FUNCTION>', workerFunc.toString());
    }

    var buildAngularWorker = function (initializedWorker) {
        var that = {};
        that.worker = initializedWorker;
        that.run = function (input) {
            var index = messageIndex++;
            indexToDeferMap[index] = $q.defer();
            var param = {
                id: index,
                input: input,
            };
            initializedWorker.postMessage(param);
            return indexToDeferMap[index].promise;
        };

        that.terminate = function () {
            initializedWorker.terminate();
        };

        return that;
    };

    function extractDependencyList(depFuncList) {
        return depFuncList.slice(0, depFuncList.length - 1);
    }

    function workerFunctionToString(func, paramList) {
        return '('+func.toString() + ')(' + paramList + ')';
    }

    return that;
}]);
