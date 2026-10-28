"""Built-in stages; importing this package registers them."""

from app.pipeline.runner import register_stage
from app.pipeline.stages.crop import CropStage
from app.pipeline.stages.yolo_classify import YoloClassifyStage
from app.pipeline.stages.yolo_detect import YoloDetectStage

register_stage("crop", CropStage)
register_stage("yolo_detect", YoloDetectStage)
register_stage("yolo_classify", YoloClassifyStage)
