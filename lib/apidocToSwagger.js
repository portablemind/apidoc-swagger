var _ = require('lodash');
var pathToRegexp = require('path-to-regexp');
var moment = require('moment');

var swagger = {
	swagger: "2.0",
	info: {},
	paths: {},
	definitions: {}
};

function toSwagger(apidocJson, projectJson) {
	swagger.info = addInfo(projectJson);
	swagger.paths = extractPaths(apidocJson);
	return swagger;
}

var tagsRegex = /(<([^>]+)>)/ig;
// Removes <p> </p> tags from text
function removeTags(text) {
	return text ? text.replace(tagsRegex, "") : text;
}

function addInfo(projectJson) {
	var info = {};
	info["title"] = projectJson.title || projectJson.name;
	info["version"] = projectJson.version;
	info["description"] = projectJson.description;
	return info;
}

/**
 * Extracts paths provided in json format
 * post, patch, put request parameters are extracted in body
 * get and delete are extracted to path parameters
 * @param apidocJson
 * @returns {{}}
 */
function extractPaths(apidocJson) {
	var apiPaths = groupByUrl(apidocJson);

	var paths = {};
	for (var i = 0; i < apiPaths.length; i++) {
		var verbs = apiPaths[i].verbs;
		var url = verbs[0].url;
		var pattern = pathToRegexp(url, null);
		var matches = pattern.exec(url);

		// Surrounds URL parameters with curly brackets -> :email with {email}
		var pathKeys = [];
		for (var j = 1; j < matches.length; j++) {
			var key = matches[j].substr(1);
			url = url.replace(matches[j], "{" + key + "}");
			pathKeys.push(key);
		}

		for (var j = 0; j < verbs.length; j++) {
			var verb = verbs[j];
			var type = verb.type;

			var obj = paths[url] = paths[url] || {};

			if (type == 'post' || type == 'patch' || type == 'put') {
				_.extend(obj, createPostPushPutOutput(verb, swagger.definitions, pathKeys));
			} else {
				_.extend(obj, createGetDeleteOutput(verb, swagger.definitions));
			}
		}
	}
	return paths;
}

function createPostPushPutOutput(verbs, definitions, pathKeys) {
	var pathItemObject = {};
	var verbDefinitionResult = createVerbDefinitions(verbs, definitions);

	var params = [];
	var pathParams = createPathParameters(verbs, pathKeys);
	pathParams = _.filter(pathParams, function(param) {
		var hasKey = pathKeys.indexOf(param.name) !== -1;
		return !(param.in === "path" && !hasKey)
	});

	params = params.concat(pathParams);

	var required = false;
	if (verbs.parameter && verbs.parameter.fields && verbs.parameter.fields.query) {
		required = verbs.parameter && verbs.parameter.fields && verbs.parameter.fields.query.length > 0;
	} else if (verbs.parameter && verbs.parameter.fields && verbs.parameter.fields.body) {
		required = verbs.parameter && verbs.parameter.fields && verbs.parameter.fields.body.length > 0;
	}

	params.push({
		"in": "body",
		"name": "body",
		"description": removeTags(verbs.description),
		"required": required,
		"schema": {
			"$ref": "#/definitions/" + verbDefinitionResult.topLevelParametersRef
		}
	});

	pathItemObject[verbs.type] = {
		tags: [verbs.group],
		summary: removeTags(verbs.description),
		consumes: [
			"application/json"
		],
		produces: [
			"application/json"
		],
		parameters: params
	}

	if (verbDefinitionResult.topLevelSuccessRef) {
		pathItemObject[verbs.type].responses = {
			"200": {
				"description": "Success",
				"schema": {
					"type": verbDefinitionResult.topLevelSuccessRefType,
					"$ref": "#/definitions/" + verbDefinitionResult.topLevelSuccessRef
				}
			}
		};
	};

	return pathItemObject;
}

function createVerbDefinitions(verbs, definitions) {
	var result = {
		topLevelParametersRef: null,
		topLevelSuccessRef: null,
		topLevelSuccessRefType: null
	};
	var defaultObjectName = verbs.name;

	var fieldArrayResult = {};
	if (verbs && verbs.parameter && verbs.parameter.fields.query) {
		fieldArrayResult = createFieldArrayDefinitions(verbs.parameter.fields.query, definitions, verbs.name, defaultObjectName);
		result.topLevelParametersRef = fieldArrayResult.topLevelRef;
	};

	if (verbs && verbs.parameter && verbs.parameter.fields.body) {
		fieldArrayResult = createFieldArrayDefinitions(verbs.parameter.fields.body, definitions, verbs.name, defaultObjectName);
		result.topLevelParametersRef = fieldArrayResult.topLevelRef;
	};

	if (verbs && verbs.success && verbs.success.fields) {
		fieldArrayResult = createFieldArrayDefinitions(verbs.success.fields["200"], definitions, verbs.name, defaultObjectName);
		result.topLevelSuccessRef = fieldArrayResult.topLevelRef;
		result.topLevelSuccessRefType = fieldArrayResult.topLevelRefType;
	};

	return result;
}

function createFieldArrayDefinitions(fieldArray, definitions, topLevelRef, defaultObjectName) {
	var result = {
		topLevelRef: topLevelRef,
		topLevelRefType: null
	}

	if (!fieldArray) {
		return result;
	}

	for (var i = 0; i < fieldArray.length; i++) {
		var parameter = fieldArray[i];

		var nestedName = createNestedName(parameter.field);
		var objectName = nestedName.objectName;
		if (!objectName) {
			objectName = defaultObjectName;
		}
		var type = parameter.type;
		if (i == 0) {
			result.topLevelRefType = type;
			if (parameter.type == "Object") {
				objectName = nestedName.propertyName;
				nestedName.propertyName = null;
			} else if (parameter.type == "Array") {
				objectName = nestedName.propertyName;
				nestedName.propertyName = null;
				result.topLevelRefType = "array";
			}
			result.topLevelRef = objectName;
		};

		definitions[objectName] = definitions[objectName] || {
			properties: {},
			required: []
		};

		if (nestedName.propertyName) {
			var prop = {
				type: (parameter.type || "").toLowerCase(),
				description: removeTags(parameter.description)
			};

			if (parameter.type == "Object") {
				prop.$ref = "#/definitions/" + parameter.field;
			}

			// Set example for date
			if (prop.type == 'date') {
				prop.example = 'YYYY-MM-DD';
			}

			// if it is datetime then convert to date-time as that is what swagger expects
			if (prop.type == 'datetime') {
				prop.type = 'date-time';
			}

			// Set example for date-time
			if (prop.type == 'date-time') {
				prop.example = 'YYYY-MM-DDThh:mm:ssTZD';
			}

			var typeIndex = type.indexOf("[]");
			if (typeIndex !== -1 && typeIndex === (type.length - 2)) {
				prop.type = "array";
				prop.items = {
					type: type.slice(0, type.length - 2),
				};
				prop.items.$ref = "#/definitions/" + parameter.field;
			}

			definitions[objectName]['properties'][nestedName.propertyName] = prop;
			if (!parameter.optional) {
				var arr = definitions[objectName]['required'];
				if (arr.indexOf(nestedName.propertyName) === -1) {
					arr.push(nestedName.propertyName);
				}
			};

		};
	}

	return result;
}

function createNestedName(field) {
	var propertyName = field;
	var objectName;
	var propertyNames = field.split(".");
	if (propertyNames && propertyNames.length > 1) {
		propertyName = propertyNames[propertyNames.length - 1];
		propertyNames.pop();
		objectName = propertyNames.join(".");
	}

	return {
		propertyName: propertyName,
		objectName: objectName
	}
}


/**
 * Generate get, delete method output
 * @param verbs
 * @returns {{}}
 */
function createGetDeleteOutput(verbs, definitions) {
	var pathItemObject = {};
	verbs.type = verbs.type === "del" ? "delete" : verbs.type;

	var verbDefinitionResult = createVerbDefinitions(verbs, definitions);
	pathItemObject[verbs.type] = {
		tags: [verbs.group],
		summary: removeTags(verbs.description),
		consumes: [
			"application/json"
		],
		produces: [
			"application/json"
		],
		parameters: createPathParameters(verbs)
	}
	if (verbDefinitionResult.topLevelSuccessRef) {
		pathItemObject[verbs.type].responses = {
			"200": {
				"description": "Success",
				"schema": {
					"type": verbDefinitionResult.topLevelSuccessRefType,
					"$ref": "#/definitions/" + verbDefinitionResult.topLevelSuccessRef
				}
			}
		};
	};
	return pathItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as path parameters
 * @param verbs
 * @returns {Array}
 */
function createPathParameters(verbs, pathKeys) {
	pathKeys = pathKeys || [];

	var pathItemObject = [];
	var fields = null;
	if (verbs.parameter && verbs.parameter.fields.query) {
		fields = verbs.parameter.fields.query;
	} else if (verbs.parameter && verbs.parameter.fields.body) {
		fields = verbs.parameter.fields.body;
	}

	if (fields) {
		for (var i = 0; i < fields.length; i++) {
			var param = fields[i];
			var field = param.field;
			var type = param.type;
			pathItemObject.push({
				name: field,
				in : type === "file" ? "formData" : "path",
				required: !param.optional,
				type: param.type.toLowerCase(),
				description: removeTags(param.description)
			});

		}
	}
	return pathItemObject;
}

function groupByUrl(apidocJson) {
	return _.chain(apidocJson)
		.groupBy("url")
		.pairs()
		.map(function(element) {
			return _.object(_.zip(["url", "verbs"], element));
		})
		.value();
}

module.exports = {
	toSwagger: toSwagger
};