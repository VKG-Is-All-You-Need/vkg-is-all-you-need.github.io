/** 设备诊断示例的映射与本体节选，在页面中展示。 */

export const TURBINE_MAPPING = `mappingId  temperature-sensor
target     :sensor/{tag} a :TemperatureSensor ; :monitors :component/{unit}/{code} .
source     SELECT s.tag, c.turbine_id AS unit, c.code
           FROM   hist_a.public.sensors s
           JOIN   hist_a.public.turbine_components c ON c.id = s.component_id
           WHERE  s.type_id = 3
           UNION
           SELECT sensor_tag, turbine_id, code
           FROM   hist_b.public.turbine_components
           WHERE  sensor_type = 3

mappingId  observation-hist-b
target     :obs/{tag}/{ts} a sosa:Observation ; sosa:madeBySensor :sensor/{tag} ;
               sosa:hasSimpleResult {value_c} ; sosa:resultTime {ts} .
source     SELECT c.sensor_tag AS tag, m.time AS ts,
                  CASE WHEN c.sensor_type = 3 THEN (m.value - 32) / 1.8
                       ELSE m.value END AS value_c
           FROM   hist_b.public.measurements m
           JOIN   hist_b.public.turbine_components c ON c.sensor_id = m.sensor_id

mappingId  observation-live
target     :obs/{tag}/{ts} a sosa:Observation ; sosa:madeBySensor :sensor/{tag} ;
               sosa:hasSimpleResult {value} ; sosa:resultTime {ts} .
source     SELECT tag, ts, value FROM live.stream.live_measurements

mappingId  turbine-unit-codes
target     :turbine/{serial} :dcsCode {dcs_code} ; :equipmentNo {equipment_no} .
source     SELECT serial, dcs_code, equipment_no FROM master.dbo.id_map

mappingId  tip-overtemperature
target     :event/{unit}/{ts} a :BurnerTipOvertemperature ;
               :component :component/{serial}/{component} ; :time {ts} .
source     SELECT a.unit, a.ts, a.component, m.serial
           FROM   events.public.alarm_log a
           JOIN   master.dbo.id_map m ON m.dcs_code = a.unit
           WHERE  a.code IN ('BT_TEMP_HI', 'E2041')

mappingId  installed-part
target     :component/{serial}/{position} :installedPart :part/{batch}/{position} .
           :part/{batch}/{position} :batch {batch} .
source     SELECT m.serial, p.position, p.batch
           FROM   cmms.pm.installed_parts p
           JOIN   master.dbo.id_map m ON m.equipment_no = p.equipment_no`;

export const TURBINE_ONTOLOGY = `:GasTurbine           rdfs:subClassOf :Equipment .
:Rotor                rdfs:subClassOf :Component .
:BurnerTip            rdfs:subClassOf :Component .
:Bearing              rdfs:subClassOf :Component .
:RotorSpeedSensor     rdfs:subClassOf :SpeedSensor .
:SpeedSensor          rdfs:subClassOf sosa:Sensor .
:TemperatureSensor    rdfs:subClassOf sosa:Sensor .
:FlameSensor          rdfs:subClassOf sosa:Sensor .
:VibrationSensor      rdfs:subClassOf sosa:Sensor .
:monitoredBy          owl:inverseOf   :monitors .
:BurnerTipOvertemperature
                      rdfs:subClassOf :Fault .
:Trip                 rdfs:subClassOf :OperationalEvent .
:Fault                rdfs:subClassOf :OperationalEvent .
:LoadRunback          rdfs:subClassOf :OperationalEvent .`;
