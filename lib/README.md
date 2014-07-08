## Modules

### Main functional classes

* Tilepin.Carto.Styles.js - CartoCSS styles compilation from JSON objects;
  it contains additional utility classes simplifying creation of JSON objects
  describing styles.
* Tilepin.MapProvider.js - this class allows render specified map zones using
  already provided Mapnik XML configuration; It allows to generate maps in the 
  following formats: PNG, SVG, PDF; It also can generate data: 
  protobuf vector tiles (PBF), GeoJSON and UTFGrid tiles used to add
  interactivity for image tiles. The same class can render vector tiles (in the
  protobuf formate) to PNG and SVG.
* Tilepin.PgConnector.js - this class allows direct connection to Postgres DB.
  Used to create data endpoints which could be called directly to search
  information in DB.
* Tilepin.ProjectConfig.js - this module is responsible for loading and 
  pre-processing configurations. This module has the following features:
  * It can load TileMill project descriptions
  * It transforms TileMill configurations to Mapnik XML configurations.
  * It allows to read configuration from multiple formats like Json
    ("project.mml"/"project.json") or Yaml (project.yml).
  * It can load only data-oriented projects used to produce protobuf vector
    tiles or only style projects used to render already existing vector tiles; 
    data-only projects can be configured using 'project.data.yaml'
    configuration; style configurations are defined in 'project.style.yml'
    files; If a project contains both type of configurations then this class
    merge both of them.
  * This class allows to pre-process datalayer configurations for various 
    query parameters; Each project can define its own javascript which contain 
    methods like "getKey" and "prepareDatasource"; the first method ("getKey")
    has to return a unique string for each new combination of parameters 
    changing the configuration. The second method ("prepareDatasource") is 
    used to change SQL queries using the specified parameters. The key from
    the first method can be used to cache modified configurations and query
    results (like produced map tiles).   
    For example: parameter "type=Organization" can change SQL query; so the
    "getKey" should look something like : getKey(params) { return params.type; }
    configuration by updating SQL queries). 
  * The "Tilepin.Project" module pre-process datalayers:
    - For "shape" layers it downloads and unzip external shape files
      referenced by absolute URLs in the "Layer.Datasource.file" field
    - For "posgis" datalayers this module can load SQL queries from external
      files referenced by the "Layer.Datasource.file" field. 
    - For "postgis" data layers it injects database access information from
      configuration files. 
  * This class pre-processes style information:
    - Loading CartoCSS styles can be defined in JSON or Javascript modules. JSON 
      style definition then serialized to the final CartoCSS using the 
      "Tilepin.Carto.Styles" class.

### Utilities

* Tilepin.js - a declaration of an empty object used as the main namespace for 
  Tilepin modules. 
* Tilepin.P.js - promises library; it is based on the  "when.js" library and
  adds some utility methods (like P.ninvoke) used in all other modules of
  Tilepin. The inital goal of this module was to allow easy switching between 
  promises (q.js, when.js...)
* Tilepin.IO.js - utility methods used to read/write text/JSON/Yaml files etc 
* Tilepin.Events.js - event firing/handling; contains additional utililty methods
