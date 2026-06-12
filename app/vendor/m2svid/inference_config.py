"""M2SVid inference model config.

Derived from upstream ``configs/m2svid.yaml`` (full-attention variant,
the released default) with two inference-only removals:

- ``loss_fn_config`` — instantiating ``OneStepLoss`` pulls LPIPS (VGG
  weight downloads) and is training-only; ``DiffusionEngine`` accepts a
  missing loss config (``loss_fn = None``).
- the ``lightning:`` trainer/callback section — training-only.

Everything that defines the network and sampling behaviour is verbatim:
13-channel UNet, OpenCLIP ViT-H per-frame conditioning, EulerEDM
``num_steps: 1`` with ``denoise_from_zero`` (a single deterministic
forward pass from a zeroed latent at sigma=700), CFG scales pinned to
1.0, and 25-frame temporal window.

Embedded as a Python string (not a .yaml data file) so it survives
Modal's ``add_local_python_source`` packaging.

The OpenCLIP checkpoint path (``...open_clip_embedding_config.params.
version``) is a placeholder; the runner overrides it with the path
inside the weights volume before instantiation.
"""

M2SVID_CONFIG_YAML = """
model:
  target: m2svid.models_for_sgm.m2svid_model.VideoLDM
  base_learning_rate: 2e-6
  params:
    input_key: video
    scale_factor: 0.18215
    log_keys: caption
    num_samples: 25
    trained_param_keys: [all]
    disable_first_stage_autocast: True
    cond_video_2nd_view: True
    cond_reprojected_video: True

    clip_condition_all_frames: True

    apply_loss_on_images: True

    denoiser_config:
      target: sgm.modules.diffusionmodules.denoiser.Denoiser
      params:
        scaling_config:
          target: sgm.modules.diffusionmodules.denoiser_scaling.VScalingWithEDMcNoise

    network_config:
      target: sgm.modules.diffusionmodules.video_model.VideoUNet
      params:
        adm_in_channels: 768
        num_classes: sequential
        use_checkpoint: True
        in_channels: 13
        out_channels: 4
        model_channels: 320
        attention_resolutions: [4, 2, 1]
        num_res_blocks: 2
        channel_mult: [1, 2, 4, 4]
        num_head_channels: 64
        use_linear_in_transformer: True
        transformer_depth: 1
        context_dim: 1024
        spatial_transformer_attn_type: softmax-xformers
        extra_ff_mix_layer: True
        use_spatial_context: True
        merge_strategy: learned_with_images
        video_kernel_size: [3, 1, 1]
        attn_inpainting_strategy: spatial_full_attention

    conditioner_config:
      target: sgm.modules.GeneralConditioner
      params:
        emb_models:
          # crossattn cond (1024)
          - is_trainable: False
            input_key: cond_frames_without_noise
            target: sgm.modules.encoders.modules.FrozenOpenCLIPImagePredictionEmbedder
            params:
              n_cond_frames: 1
              n_copies: 1
              open_clip_embedding_config:
                target: sgm.modules.encoders.modules.FrozenOpenCLIPImageEmbedder
                params:
                  version: "ckpts/open_clip_pytorch_model.bin"
                  freeze: True

          # vector cond (256)
          - input_key: fps_id
            is_trainable: False
            target: sgm.modules.encoders.modules.ConcatTimestepEmbedderND
            params:
              outdim: 256

          # vector cond (256)
          - input_key: motion_bucket_id
            is_trainable: False
            target: sgm.modules.encoders.modules.ConcatTimestepEmbedderND
            params:
              outdim: 256

          # concat cond (4)
          - input_key: cond_video_2nd_view
            is_trainable: False
            target: sgm.modules.encoders.modules.VideoPredictionEmbedderWithEncoder
            params:
              disable_encoder_autocast: True
              n_cond_frames: 1
              n_copies: 1
              is_ae: True
              encoder_config:
                target: sgm.models.autoencoder.AutoencoderKLModeOnly
                params:
                  embed_dim: 4
                  monitor: val/rec_loss
                  ddconfig:
                    attn_type: vanilla-xformers
                    double_z: True
                    z_channels: 4
                    resolution: 256
                    in_channels: 3
                    out_ch: 3
                    ch: 128
                    ch_mult: [1, 2, 4, 4]
                    num_res_blocks: 2
                    attn_resolutions: []
                    dropout: 0.0
                  lossconfig:
                    target: torch.nn.Identity

          # vector cond (256)
          - input_key: cond_aug
            is_trainable: False
            target: sgm.modules.encoders.modules.ConcatTimestepEmbedderND
            params:
              outdim: 256

          # concat cond (4)
          - input_key: cond_reprojected_video
            is_trainable: False
            target: sgm.modules.encoders.modules.VideoPredictionEmbedderWithEncoder
            params:
              disable_encoder_autocast: True
              n_cond_frames: 1
              n_copies: 1
              is_ae: True
              encoder_config:
                target: sgm.models.autoencoder.AutoencoderKLModeOnly
                params:
                  embed_dim: 4
                  monitor: val/rec_loss
                  ddconfig:
                    attn_type: vanilla-xformers
                    double_z: True
                    z_channels: 4
                    resolution: 256
                    in_channels: 3
                    out_ch: 3
                    ch: 128
                    ch_mult: [1, 2, 4, 4]
                    num_res_blocks: 2
                    attn_resolutions: []
                    dropout: 0.0
                  lossconfig:
                    target: torch.nn.Identity

          # concat cond (1)
          - input_key: reprojected_mask
            is_trainable: False
            target: m2svid.models_for_sgm.embedders.ConcatEmbedder
            params: {}

    first_stage_config:
      target: sgm.models.autoencoder.AutoencodingEngine
      params:
        loss_config:
          target: torch.nn.Identity
        regularizer_config:
          target: sgm.modules.autoencoding.regularizers.DiagonalGaussianRegularizer
        encoder_config:
          target: sgm.modules.diffusionmodules.model.Encoder
          params:
            attn_type: vanilla
            double_z: True
            z_channels: 4
            resolution: 256
            in_channels: 3
            out_ch: 3
            ch: 128
            ch_mult: [1, 2, 4, 4]
            num_res_blocks: 2
            attn_resolutions: []
            dropout: 0.0
        decoder_config:
          target: sgm.modules.autoencoding.temporal_ae.VideoDecoder
          params:
            attn_type: vanilla
            double_z: True
            z_channels: 4
            resolution: 256
            in_channels: 3
            out_ch: 3
            ch: 128
            ch_mult: [1, 2, 4, 4]
            num_res_blocks: 2
            attn_resolutions: []
            dropout: 0.0
            video_kernel_size: [3, 1, 1]

    sampler_config:
      target: sgm.modules.diffusionmodules.sampling.EulerEDMSampler
      params:
        num_steps: 1
        verbose: False
        denoise_from_zero: True

        discretization_config:
          target: sgm.modules.diffusionmodules.discretizer.EDMDiscretization
          params:
            sigma_max: 700.0
            spacing: 'trailing'

        guider_config:
          target: sgm.modules.diffusionmodules.guiders.LinearPredictionGuider
          params:
            num_frames: 25
            max_scale: 1.0
            min_scale: 1.0
"""
