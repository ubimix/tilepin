var FS = require('fs');
var Path = require('path');
var _ = require('underscore');
var Tilepin = require('./lib/');

function clone(json) {
    return JSON.parse(JSON.stringify(json));
}

module.exports = {
    splitProjectConfig : function(json) {
        var template = clone(json);
        template.Stylesheet = [];
        template.Layer = [];
        var templateStr = JSON.stringify(template);
        return _.map(json.Layer, function(layer) {
            var config = JSON.parse(templateStr);
            var l = clone(layer);
            var table = l.Datasource && l.Datasource.table ? l.Datasource.table
                    : null;
            if (table) {
                console.log(table);
                table = table.replace(/\\n/gim, '\n');
                l.Datasource.table = table;
            }
            delete l.Datasource.project;
            delete l.Datasource.id;
            delete l.Datasource.dbname;
            delete l.id;
            delete l.project;
            config.Layer.push(l);
            config.name = layer.name;
            return config;
        });
    },

    splitProject : function(projectPath, targetDir) {
        var that = this;
        return Tilepin.IO.readJson(projectPath).then(function(json) {
            return that.splitProjectConfig(json);
        }).then(function(configList) {
            return Tilepin.P.all(_.map(configList, function(config) {
                var projectName = config.name;
                var projectDir = Path.join(targetDir, projectName);
                return Tilepin.IO.mkdirs(projectDir).then(function() {
                    var path = Path.join(projectDir, 'project.yml');
                    return Tilepin.IO.writeYaml(path, config);
                });
            }));
        })
    }
}
